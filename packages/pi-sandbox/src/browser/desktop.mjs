/** A private native display and maintained WebSocket/RFB transport per browser. */
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {createConnection} from 'node:net';
import {writeFile,chmod} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {createInterface} from 'node:readline';
import {WebSocketServer,createWebSocketStream} from 'ws';

export function xauthority(display,cookie) {
  const parts=[Buffer.from([255,255])];
  for(const value of [Buffer.alloc(0),Buffer.from(display),Buffer.from('MIT-MAGIC-COOKIE-1'),cookie]) {
    const length=Buffer.alloc(2);length.writeUInt16BE(value.length);parts.push(length,value);
  }
  return Buffer.concat(parts);
}

async function stop(child) {
  if(!child?.pid || child.exitCode!==null || child.signalCode!==null)return;
  await new Promise(resolve=>{
    const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
    child.once('exit',()=>{clearTimeout(timer);resolve();});
    child.kill('SIGTERM');
  });
}

export async function startDesktop(profile) {
  const children=[],connections=new Set();
  let server,wss,closed=false,failure,onFailure;
  const failed=error=>{if(!closed){failure??=error;onFailure?.(failure);}};
  const kill=()=>{for(const child of children)child.kill('SIGKILL');};
  const close=async()=>{
    if(closed)return;closed=true;
    for(const connection of connections)connection.destroy();
    for(const client of wss?.clients??[])client.terminate();
    if(server?.listening)await new Promise(resolve=>server.close(resolve));
    wss?.close();
    for(const child of [...children].reverse())await stop(child);
  };
  function launch(command,args,options={}) {
    // Kernel parent-death handling also covers an abruptly killed Pi worker.
    const child=spawn('setpriv',['--pdeathsig','KILL','--',command,...args],{
      stdio:['ignore','ignore','pipe'],...options,
    });
    children.push(child);
    // Drain diagnostics; retain a bounded tail for a startup error.
    child.diagnostic='';
    child.stderr?.on('data',data=>{child.diagnostic=(child.diagnostic+data).slice(-2000);});
    child.on('error',failed);
    child.once('exit',(code,signal)=>failed(Error(command+' exited ('+(signal??code)+')')));
    return child;
  }
  try {
    const authority=profile+'/Xauthority',cookie=randomBytes(16);
    await writeFile(authority,xauthority('0',cookie),{mode:0o600});
    const displayProcess=launch('Xvnc',[
      '-displayfd','3','-auth',authority,'-nolisten','tcp','-rfbport','-1',
      '-rfbunixpath',profile+'/vnc.sock','-rfbunixmode','0600','-SecurityTypes','None',
      '-geometry','1280x800','-depth','24','-AlwaysShared','-AcceptSetDesktopSize=1',
      '-SendPrimary=0','-SetPrimary=0',
    ],{stdio:['ignore','ignore','pipe','pipe']});
    const display=await new Promise((resolve,reject)=>{
      const lines=createInterface({input:displayProcess.stdio[3]});
      const finish=(error,value)=>{
        clearTimeout(timer);lines.close();displayProcess.off('error',onError);displayProcess.off('exit',onExit);
        if(error)reject(error);else resolve(value);
      };
      const onError=error=>finish(error);
      const onExit=code=>finish(Error('Browser display exited ('+code+'): '+displayProcess.diagnostic));
      const timer=setTimeout(()=>finish(Error('Browser display startup timed out')),30000);
      displayProcess.once('error',onError);displayProcess.once('exit',onExit);
      lines.once('line',number=>/^\d{1,5}$/.test(number.trim())
        ?finish(null,':'+number.trim()):finish(Error('Invalid browser display')));
    });
    // The server loads the cookie at startup; clients need the selected display.
    await writeFile(authority,xauthority(display.slice(1),cookie),{mode:0o600});
    const env={...process.env,DISPLAY:display,XAUTHORITY:authority};
    await writeFile(profile+'/openbox.xml',
      '<openbox_config xmlns="http://openbox.org/3.4/rc"><focus><focusNew>yes</focusNew><followMouse>no</followMouse></focus><keyboard/><mouse/><menu/><applications><application class="*" type="normal"><decor>no</decor><maximized>yes</maximized></application></applications></openbox_config>',{mode:0o600});
    launch('openbox',['--config-file',profile+'/openbox.xml'],{env});
    launch('vncconfig',['-nowin'],{env});
    wss=new WebSocketServer({noServer:true,maxPayload:1024*1024,perMessageDeflate:false});
    server=createServer((_request,response)=>{response.writeHead(404);response.end();});
    server.on('error',failed);
    server.on('connection',connection=>{
      connections.add(connection);connection.once('close',()=>connections.delete(connection));
    });
    server.on('upgrade',(request,socket,head)=>{
      if(request.url!=='/vnc'){socket.destroy();return;}
      wss.handleUpgrade(request,socket,head,websocket=>{
        const stream=createWebSocketStream(websocket);
        const desktop=createConnection({path:profile+'/vnc.sock'});
        const finish=()=>{desktop.destroy();stream.destroy();websocket.terminate();};
        desktop.on('error',finish);stream.on('error',finish);
        desktop.on('close',()=>{stream.end();});stream.on('close',()=>desktop.destroy());
        desktop.pipe(stream).pipe(desktop);
      });
    });
    await new Promise((resolve,reject)=>{
      server.once('error',reject);server.listen(profile+'/desktop.sock',resolve);
    });
    await chmod(profile+'/desktop.sock',0o600);
    if(failure)throw failure;
    return {env,close,kill,display,pids:children.map(child=>child.pid),
      onFailure(callback){onFailure=callback;if(failure)callback(failure);}};
  } catch(error) {await close();throw error;}
}
