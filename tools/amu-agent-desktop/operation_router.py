"""Capability-based route selection and bounded cross-process desktop workflow leases."""
import json, time, uuid, os
from pathlib import Path
OWNER=uuid.uuid4().hex
ROUTES=['connector','local_file','creator','amu_preview','browser_dom','desktop','desktop_input','computer_use']
def route(a):
 kind=a.get('kind'); available=a.get('available',[])
 if kind not in ['service','file','web','native','video']:raise ValueError('Invalid kind')
 if not isinstance(available,list) or any(x not in ROUTES for x in available):raise ValueError('Invalid available routes')
 if a.get('human_active'):return {'route':None,'decision':'wait','reason':'Human is driving the target; do not mutate or steal focus.'}
 if a.get('delivery_uncertain'):return {'route':None,'decision':'observe','reason':'Verify live state before retrying or switching tools.'}
 preferred=a.get('preferred')
 if preferred and preferred not in ROUTES:raise ValueError('Invalid preferred route')
 if preferred:
  candidates=[preferred]
 elif kind=='video':candidates=['creator']
 elif kind=='file':candidates=['local_file','connector']
 elif kind=='service':candidates=['connector','amu_preview','browser_dom']
 elif kind=='web':candidates=['amu_preview','browser_dom']
 else:candidates=['desktop','desktop_input','computer_use']
 if a.get('profile_required') and not a.get('preview_profile_available'):
  candidates=[x for x in candidates if x!='amu_preview']
 eligible=[]
 for x in candidates:
  if x not in available:continue
  if x in ('desktop_input','computer_use') and not a.get('physical_authorized'):continue
  if x=='desktop_input' and not a.get('semantic_unavailable'):continue
  eligible.append(x)
 selected=next(iter(eligible),None)
 return {'route':selected,'decision':'use' if selected else 'unavailable','candidates':candidates,
 'reason':'Select the first available route satisfying task, profile and authorization constraints.',
 'verification':'Read back the target state; an action success is not task completion.',
 'coordination':'Pin target tab/window. Do not share a mutable target. Desktop workflows acquire desktop_lease; external tools must cooperate.',
 'limits':'Capabilities and human state are caller-supplied, not automatically detected. This does not guarantee optimality or external exclusion.'}
def read_lease(root):
 p=root/'workflow-lease.json'
 if not p.exists():return None
 d=json.loads(p.read_text())
 if d['expires']<=time.time():p.unlink();return None
 return d
def lease(root,action,seconds=120):
 if action not in ['acquire','renew','release','status']:raise ValueError('Invalid lease action')
 if type(seconds) is not int or not 10<=seconds<=300:raise ValueError('seconds must be 10..300')
 d=read_lease(root)
 if action=='status':return {'busy':bool(d),'owned':bool(d and d['owner']==OWNER),'expires':d['expires'] if d else None}
 if d and d['owner']!=OWNER:raise ValueError('Desktop workflow owned by another MCP connection')
 if action=='release':
  if d:(root/'workflow-lease.json').unlink()
  return {'released':True}
 if action=='renew' and not d:raise ValueError('No active lease to renew')
 d={'owner':OWNER,'expires':time.time()+seconds,'pid':os.getpid()}
 p=root/'workflow-lease.json';p.write_text(json.dumps(d));p.chmod(0o600)
 return {'owned':True,'expires':d['expires']}
def check_lease(root):
 d=read_lease(root)
 if d and d['owner']!=OWNER:raise ValueError('Desktop reserved by another workflow; wait without switching to another desktop tool')
ROUTE_SCHEMA={'type':'object','properties':{
 'kind':{'type':'string','enum':['service','file','web','native','video']},
 'available':{'type':'array','items':{'type':'string','enum':ROUTES}},
 'preferred':{'type':'string','enum':ROUTES},
 **{k:{'type':'boolean'} for k in ['human_active','delivery_uncertain','profile_required','preview_profile_available','physical_authorized','semantic_unavailable']}},'required':['kind','available'],'additionalProperties':False}
LEASE_SCHEMA={'type':'object','properties':{'action':{'type':'string','enum':['acquire','renew','release','status']},'seconds':{'type':'integer','minimum':10,'maximum':300}},'required':['action'],'additionalProperties':False}
