#!/usr/bin/env python3
"""BL-A render queue: one job, fresh Blender per 60 frames, verified resume and atomic publication."""
from __future__ import annotations
import argparse
import ast
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import uuid
import zlib
import media_guard as guard

BLENDER = "/Applications/Blender.app/Contents/MacOS/Blender"
SCRIPTS = Path("/Volumes/SSD 1TB/宇宙案内人さき/長尺/No.1/作業データ/3DCG/scripts")

def number(node):
    if isinstance(node, ast.Constant) and type(node.value) in (int, float):
        return node.value
    if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub, ast.Mult, ast.Div)):
        a, b = number(node.left), number(node.right)
        return {ast.Add: lambda:a+b, ast.Sub:lambda:a-b, ast.Mult:lambda:a*b, ast.Div:lambda:a/b}[type(node.op)]()
    raise ValueError("DUR must be a numeric expression; inspect this shot before rendering")

def shot_spec(script):
    assignments = {t.id:n.value for n in ast.parse(script.read_text()).body
                   if isinstance(n, ast.Assign) for t in n.targets if isinstance(t, ast.Name)}
    shot = ast.literal_eval(assignments["SHOT"])
    if not isinstance(shot,str) or not shot or any(c in shot for c in "/\\\0"):
        raise ValueError("Invalid SHOT")
    if ast.unparse(assignments["nf"]) != "int(round(DUR * C.FPS))":
        raise ValueError("Frame count formula changed; inspect this shot before rendering")
    common = ast.parse((script.parent/"bla_common.py").read_text())
    fps = next(ast.literal_eval(n.value) for n in common.body if isinstance(n,ast.Assign)
               and any(isinstance(t,ast.Name) and t.id=="FPS" for t in n.targets))
    width,height = next(ast.literal_eval(n.value) for n in common.body if isinstance(n,ast.Assign)
                        and any(isinstance(t,ast.Tuple) and [x.id for x in t.elts]==["W","H"] for t in n.targets))
    return shot, int(round(number(assignments["DUR"])*fps)), fps, width, height

def valid_png(file, width, height):
    """CRC and final IEND detect placeholders, partial writes, and damaged chunks without decoding in RAM."""
    try:
        with file.open("rb") as f:
            if f.read(8)!=b"\x89PNG\r\n\x1a\n": return False
            header=False
            pixels=False
            while True:
                lead=f.read(8)
                if len(lead)!=8: return False
                size,kind=struct.unpack(">I4s",lead)
                if size>128*1024**2: return False
                crc=zlib.crc32(kind)
                first=b""
                remaining=size
                while remaining:
                    part=f.read(min(remaining,1024**2))
                    if not part: return False
                    if kind==b"IHDR": first+=part
                    crc=zlib.crc32(part,crc)
                    remaining-=len(part)
                tail=f.read(4)
                if len(tail)!=4 or crc&0xffffffff!=struct.unpack(">I",tail)[0]: return False
                if kind==b"IHDR":
                    if header or size!=13 or struct.unpack(">II",first[:8])!=(width,height): return False
                    header=True
                if kind==b"IDAT": pixels=True
                if kind==b"IEND": return header and pixels and size==0 and f.read(1)==b""
    except (OSError,ValueError,struct.error):
        return False

def digest_run(script,args):
    digest=hashlib.sha256(b"amu-safe-blender-v1\0")
    for p in sorted(script.parent.glob("*.py")):
        digest.update(p.name.encode());digest.update(p.read_bytes())
    tex=script.parent.parent/"tex"
    if tex.exists():
        for p in sorted(tex.rglob("*")):
            if p.is_file():
                info=p.stat()
                digest.update(str(p.relative_to(tex)).encode())
                digest.update(f"{info.st_size}:{info.st_mtime_ns}".encode())
    info=Path(BLENDER).stat()
    digest.update(f"{info.st_size}:{info.st_mtime_ns}".encode())
    digest.update(json.dumps({k:v for k,v in vars(args).items() if k!="plan"},sort_keys=True).encode())
    return digest.hexdigest()[:16]

def checkpoint(output):
    result=guard.evaluate(guard.collect([guard.DEFAULT_PROJECT],output))
    guard.display(result)
    if result["blocked"]: raise RuntimeError("Render admission refused")

def checked_job(command, fd, output):
    result=guard.run_job(command,fd,output_dir=output)
    if result: raise RuntimeError(f"Media command failed: exit {result}")

def encode(frames,first,last,fps,width,height,destination,fd):
    for frame in range(first,last+1):
        if not valid_png(frames/f"f_{frame:04d}.png",width,height):
            raise RuntimeError(f"Frame {frame} is missing or invalid; encoding refused")
    checkpoint(destination.parent)
    temp=destination.with_name(destination.stem+".partial-"+uuid.uuid4().hex+".mp4")
    checked_job(["ffmpeg","-nostdin","-v","error","-xerror","-err_detect","explode",
                 "-framerate",str(fps),"-start_number",str(first),"-i",str(frames/"f_%04d.png"),
                 "-frames:v",str(last-first+1),"-c:v","libx264","-threads","2","-preset","slow",
                 "-crf","16","-pix_fmt","yuv420p","-movflags","+faststart","-an",str(temp)],fd,destination.parent)
    data=json.loads(subprocess.check_output(["ffprobe","-v","error","-count_frames",
          "-select_streams","v:0","-show_entries","stream=width,height,nb_read_frames,r_frame_rate",
          "-of","json",str(temp)],text=True,timeout=180))["streams"][0]
    if (data["width"],data["height"],int(data["nb_read_frames"]),data["r_frame_rate"])!=(width,height,last-first+1,f"{fps}/1"):
        raise RuntimeError("Encoded movie did not match dimensions, frame count and frame rate")
    os.replace(temp,destination)

def publish(source,destination):
    if destination.exists():
        backup=destination.with_name(destination.stem+".before-"+dt.datetime.now().strftime("%Y%m%d-%H%M%S")+"-"+uuid.uuid4().hex[:6]+destination.suffix)
        shutil.copy2(destination,backup)
    temp=destination.with_name(destination.stem+".publishing-"+uuid.uuid4().hex+destination.suffix)
    shutil.copy2(source,temp)
    with source.open("rb") as a, temp.open("rb") as b:
        if hashlib.file_digest(a,"sha256").digest()!=hashlib.file_digest(b,"sha256").digest():
            raise RuntimeError("Publication copy failed verification")
    os.replace(temp,destination)

def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("id")
    p.add_argument("--samples",type=int,default=64)
    p.add_argument("--preview",action="store_true")
    p.add_argument("--start",type=int)
    p.add_argument("--end",type=int)
    p.add_argument("--tag",default="")
    p.add_argument("--encode-existing",action="store_true")
    p.add_argument("--plan",action="store_true")
    args=p.parse_args(argv)
    if not __import__("re").fullmatch(r"A\d{2}",args.id): p.error("ID must be A01 through A13")
    script=SCRIPTS/f"bla_{args.id}.py"
    shot,nf,fps,width,height=shot_spec(script)
    first,last=1 if args.start is None else args.start,nf if args.end is None else args.end
    if not 1<=first<=last<=nf or not 1<=args.samples<=4096: p.error("Invalid frame range or samples")
    if args.preview: width//=2;height//=2
    renders=SCRIPTS.parent/"renders"
    run=renders/"safe"/(shot+"-"+digest_run(script,args))
    destination=renders/(shot+(f"_f{first:04d}-{last:04d}" if (first,last)!=(1,nf) else "")+("_preview" if args.preview else "")+".mp4")
    plan=dict(shot=shot,frames=[first,last],fps=fps,width=width,height=height,chunk_frames=60,run=str(run),destination=str(destination))
    if args.plan:
        print(json.dumps(plan,ensure_ascii=False,indent=2));return 0
    renders.mkdir(exist_ok=True)
    with guard.exclusive_lock() as fd:
        checkpoint(renders)
        run.mkdir(parents=True,exist_ok=True)
        if args.encode_existing:
            frames=renders/(shot+"_frames")
        else:
            (run/"manifest.json").write_text(json.dumps(plan,ensure_ascii=False,indent=2))
            frames=run/(shot+"_frames");frames.mkdir(exist_ok=True)
            bootstrap=run/"bootstrap.py"
            bootstrap.write_text("import sys,runpy\nfrom pathlib import Path\nsys.path.insert(0,"+repr(str(SCRIPTS))+")\nimport bla_common as C\nC.RENDERS=Path("+repr(str(run))+")\nrunpy.run_path("+repr(str(script))+",run_name='__main__')\n")
            for begin in range(first,last+1,60):
                end=min(last,begin+59)
                pending=[]
                for frame in range(begin,end+1):
                    file=frames/f"f_{frame:04d}.png"
                    if valid_png(file,width,height): continue
                    if file.exists():
                        invalid=run/"invalid";invalid.mkdir(exist_ok=True)
                        file.rename(invalid/(file.name+"."+uuid.uuid4().hex))
                    pending.append(frame)
                if not pending: continue
                checkpoint(renders)
                print(f"CHUNK {begin}-{end} / {last}",flush=True)
                command=[BLENDER,"-b","--python-exit-code","1","--python",str(bootstrap),"--",
                         "--samples",str(args.samples),"--start",str(begin),"--end",str(end)]
                if args.preview: command.append("--preview")
                checked_job(command,fd,renders)
                if any(not valid_png(frames/f"f_{i:04d}.png",width,height) for i in range(begin,end+1)):
                    raise RuntimeError("Chunk ended with missing or damaged frames; resume this same command")
        movie=run/(shot+".mp4")
        encode(frames,first,last,fps,width,height,movie,fd)
        publish(movie,destination)
        print("VERIFIED "+str(destination),flush=True)
    return 0

if __name__=="__main__":
    try: sys.exit(main())
    except (OSError,ValueError,RuntimeError,subprocess.SubprocessError) as e:
        print("STOPPED: "+str(e),file=sys.stderr);sys.exit(2)
