import argparse
import contextlib
import io
import json
from pathlib import Path
import signal
import struct
import subprocess
import tempfile
import unittest
from unittest import mock
import zlib
import blender_safe as safe
import media_guard as guard

def png(width=2,height=2):
    def chunk(kind,data):
        return struct.pack(">I",len(data))+kind+data+struct.pack(">I",zlib.crc32(kind+data)&0xffffffff)
    return b"\x89PNG\r\n\x1a\n"+chunk(b"IHDR",struct.pack(">IIBBBBB",width,height,8,2,0,0,0))+chunk(b"IDAT",zlib.compress((b"\0"+b"\0"*(width*3))*height))+chunk(b"IEND",b"")

class BlenderSafetyTests(unittest.TestCase):
    def test_partial_placeholder_crc_and_dimensions(self):
        with tempfile.TemporaryDirectory() as d:
            f=Path(d)/"frame.png"
            for data in [b"",png()[:-12],png()[:-5]+b"error",png(4,2)]:
                f.write_bytes(data)
                self.assertFalse(safe.valid_png(f,2,2))
            f.write_bytes(png())
            self.assertTrue(safe.valid_png(f,2,2))

    def test_resume_restarts_only_chunk_with_bad_frame_and_preserves_old_output(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);scripts=root/"scripts";scripts.mkdir();(root/"renders").mkdir()
            (scripts/"bla_common.py").write_text("FPS=30\nW,H=2,2\n")
            (scripts/"bla_A01.py").write_text('SHOT="A01_demo"\nDUR=5\nnf=int(round(DUR*C.FPS))\n')
            chunks=[]
            def job(argv,fd,output):
                begin=int(argv[argv.index("--start")+1]);end=int(argv[argv.index("--end")+1])
                chunks.append((begin,end))
                bootstrap=Path(argv[argv.index("--python")+1])
                frames=bootstrap.parent/"A01_demo_frames"
                for i in range(begin,end+1): (frames/f"f_{i:04d}.png").write_bytes(png())
            def encode(frames,first,last,fps,width,height,destination,fd):
                self.assertTrue(all(safe.valid_png(frames/f"f_{i:04d}.png",width,height) for i in range(first,last+1)))
                destination.write_bytes(b"new verified movie")
            output=root/"renders/A01_demo.mp4";output.write_bytes(b"previous accepted movie")
            with mock.patch.object(safe,"SCRIPTS",scripts),mock.patch.object(safe,"checkpoint"), \
                 mock.patch.object(safe,"checked_job",side_effect=job),mock.patch.object(safe,"encode",side_effect=encode), \
                 mock.patch.object(guard,"exclusive_lock",return_value=contextlib.nullcontext(5)), \
                 contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(safe.main(["A01"]),0)
                self.assertEqual(chunks,[(1,60),(61,120),(121,150)])
                chunks.clear()
                safe.main(["A01"])
                self.assertEqual(chunks,[])
                frame=next((root/"renders/safe").glob("*/A01_demo_frames/f_0061.png"))
                frame.write_bytes(b"")
                safe.main(["A01"])
                self.assertEqual(chunks,[(61,120)])
                self.assertTrue(list((frame.parent.parent/"invalid").iterdir()))
            self.assertEqual(output.read_bytes(),b"new verified movie")
            self.assertTrue(any(p.read_bytes()==b"previous accepted movie" for p in output.parent.glob("*.before-*.mp4")))

    def test_failed_chunk_does_not_publish_or_encode(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);scripts=root/"scripts";scripts.mkdir();(root/"renders").mkdir()
            (scripts/"bla_common.py").write_text("FPS=30\nW,H=2,2\n")
            (scripts/"bla_A01.py").write_text('SHOT="A01_demo"\nDUR=1\nnf=int(round(DUR*C.FPS))\n')
            output=root/"renders/A01_demo.mp4";output.write_bytes(b"accepted")
            with mock.patch.object(safe,"SCRIPTS",scripts),mock.patch.object(safe,"checkpoint"), \
                 mock.patch.object(safe,"checked_job",side_effect=RuntimeError("crashed")), \
                 mock.patch.object(safe,"encode") as enc, \
                 mock.patch.object(guard,"exclusive_lock",return_value=contextlib.nullcontext(5)), \
                 contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(RuntimeError): safe.main(["A01"])
                enc.assert_not_called()
            self.assertEqual(output.read_bytes(),b"accepted")

    def test_monitor_only_terminates_its_owned_group(self):
        with tempfile.TemporaryDirectory() as d:
            directory=Path(d)/"lock"
            child=mock.Mock(pid=123456)
            child.wait.side_effect=[subprocess.TimeoutExpired("own",3),subprocess.TimeoutExpired("own",3),0]
            with guard.exclusive_lock(directory) as fd, \
                 mock.patch.object(guard.subprocess,"Popen",return_value=child), \
                 mock.patch.object(guard,"memory_sample",return_value={"pressure":4}), \
                 mock.patch.object(guard.shutil,"disk_usage",return_value=mock.Mock(free=100*guard.GIB)), \
                 mock.patch.object(guard.os,"killpg") as kill:
                self.assertEqual(guard.run_job(["owned-child"],fd,Path(d)),2)
                kill.assert_called_once_with(123456,signal.SIGTERM)
                child.wait.assert_called_with(timeout=15)

    def test_encoder_refuses_incomplete_frames_without_launch(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(safe,"checked_job") as job:
            root=Path(d);(root/"f_0001.png").write_bytes(png())
            with self.assertRaises(RuntimeError):
                safe.encode(root,1,2,30,2,2,root/"out.mp4",5)
            job.assert_not_called()

if __name__=="__main__": unittest.main()
