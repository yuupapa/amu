import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import media_guard as guard

class GuardTests(unittest.TestCase):
    def baseline(self):
        return dict(time="test", errors=[], repositories=[], processes=[], output_dir="/tmp/output",
                    memory=dict(pressure=1, pressure_before=1, swap_used_bytes=0, swap_io_mib_per_second=0),
                    internal_free_bytes=100 * guard.GIB, output_free_bytes=100 * guard.GIB)

    def test_swap_amount_alone_does_not_block(self):
        data = self.baseline()
        data["memory"]["swap_used_bytes"] = 8 * guard.GIB
        result = guard.evaluate(data)
        self.assertEqual(result["status"], "READY")
        self.assertTrue(result["warnings"])

    def test_pressure_or_swap_traffic_blocks(self):
        for field, value in [("pressure", 2), ("pressure_before", 4), ("swap_io_mib_per_second", 33)]:
            data = self.baseline()
            data["memory"][field] = value
            self.assertEqual(guard.evaluate(data)["status"], "BLOCKED")

    def test_running_blender_blocks_without_rss(self):
        data = self.baseline()
        data["processes"] = [dict(name="Blender", pid=123, elapsed="01:00")]
        self.assertEqual(guard.evaluate(data)["status"], "BLOCKED")

    def test_preview_browsers_pass_only_with_explicit_option(self):
        data = self.baseline()
        data["processes"] = [dict(name="chrome-headless-shell", pid=1, elapsed="01:00", preview_parent=True)]
        self.assertEqual(guard.evaluate(data)["status"], "BLOCKED")
        self.assertEqual(guard.evaluate(data, allow_preview_browsers=True)["status"], "READY")
        data["processes"] += [dict(name="chrome-headless-shell", pid=2, elapsed="01:00", preview_parent=False),
                              dict(name="ffmpeg", pid=3, elapsed="01:00")]
        result = guard.evaluate(data, allow_preview_browsers=True)
        self.assertEqual(len(result["blocked"]), 2)

    def test_preview_parent_matches_amu_and_preview_but_not_render(self):
        match = guard.PREVIEW_PARENT.search
        self.assertTrue(match("/Users/x/Applications/Amu.app/Contents/MacOS/Amu --require a"))
        self.assertTrue(match("node /x/.bin/hyperframes preview /p --port 1"))
        self.assertTrue(match("npm exec hyperframes@0.8.143 preview /p"))
        self.assertFalse(match("node /x/.bin/hyperframes render /p"))
        self.assertFalse(match("/Applications/Amu.app/Contents/Frameworks/Amu Helper (Renderer).app/x"))

    def test_missing_measurement_and_low_disk_fail_closed(self):
        for change in [dict(errors=["cannot measure"]), dict(output_free_bytes=49 * guard.GIB)]:
            data = self.baseline()
            data.update(change)
            self.assertEqual(guard.evaluate(data)["status"], "BLOCKED")

    def test_git_audit_preserves_index_and_temporary_objects(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            guard.command(["git", "init", "-q", str(root)])
            (root / ".gitignore").write_text("*.mp4\nnode_modules/\n")
            (root / "edit.html").write_text("editable")
            (root / "video.mp4").write_bytes(b"media")
            (root / "node_modules").mkdir()
            (root / "node_modules/dependency").write_bytes(b"dependency")
            guard.command(["git", "-C", str(root), "add", "-f", "video.mp4"])
            index = (root / ".git/index").read_bytes()
            (root / "ignored.mp4").write_bytes(b"ignored")
            temp = root / ".git/objects/pack/tmp_pack_test"
            temp.write_bytes(b"in-progress")
            with (root / "large.dat").open("wb") as stream:
                stream.truncate(51 * guard.MIB)
            result = guard.repository(root)
            self.assertEqual(result["candidate_count"], 4)
            self.assertEqual(result["large_files"][0]["path"], "large.dat")
            self.assertEqual(len(result["temporary_files"]), 1)
            self.assertEqual((root / ".git/index").read_bytes(), index)
            self.assertEqual(temp.read_bytes(), b"in-progress")
            data = self.baseline()
            data["repositories"] = [result]
            self.assertEqual(guard.evaluate(data)["status"], "BLOCKED")

    def test_output_symlink_inside_project_blocks(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            project = root / "project"
            project.mkdir()
            (project / "exports").mkdir()
            link = root / "shortcut"
            link.symlink_to(project / "exports")
            data = self.baseline()
            data["output_dir"] = str(link)
            data["repositories"] = [dict(root=str(project), temporary_files=[], large_files=[], candidate_bytes=0)]
            self.assertEqual(guard.evaluate(data)["status"], "BLOCKED")

    def test_lock_contention_and_recovery(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder) / "lock"
            script = "from pathlib import Path; from media_guard import exclusive_lock;\nwith exclusive_lock(Path(__import__('sys').argv[1])): print('acquired')"
            with guard.exclusive_lock(directory):
                second = subprocess.run([sys.executable, "-c", script, str(directory)],
                                        cwd=Path(__file__).parent, capture_output=True, text=True, timeout=5)
                self.assertNotEqual(second.returncode, 0)
                self.assertIn("共通ロック", second.stderr)
            with guard.exclusive_lock(directory):
                pass

    def test_blocked_run_never_starts_command(self):
        data = self.baseline()
        data["errors"] = ["deliberate blocker"]
        with mock.patch.object(guard, "collect", return_value=data), \
             mock.patch.object(guard, "exclusive_lock") as lock, \
             mock.patch.object(guard, "run_job") as launch:
            lock.return_value.__enter__.return_value = 5
            result = guard.main(["run", "--output-dir", "/tmp", "--", "/usr/bin/true"])
            self.assertEqual(result, 2)
            launch.assert_not_called()

    def test_foreground_command_exit_status_and_crash_recovery(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder) / "lock"
            with guard.exclusive_lock(directory) as fd:
                code = guard.run_job([sys.executable, "-c", "raise SystemExit(7)"], fd)
                self.assertEqual(code, 7)
            crash = "from pathlib import Path; import os,sys; from media_guard import exclusive_lock;\nwith exclusive_lock(Path(sys.argv[1])): os._exit(0)"
            subprocess.run([sys.executable, "-c", crash, str(directory)],
                           cwd=Path(__file__).parent, check=True, timeout=5)
            with guard.exclusive_lock(directory):
                pass

if __name__ == "__main__":
    unittest.main()
