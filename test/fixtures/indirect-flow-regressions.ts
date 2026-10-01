import {createRoot,createSignal} from "solid-js";
import {createDataLayer} from "../../web/src/indirect-code/store/sessions";
import {createTranscript} from "../../web/src/indirect-code/hooks/useTranscript";
import {createBackground} from "../../web/src/indirect-code/hooks/useBackground";
import {createTurnChanges} from "../../web/src/indirect-code/hooks/useTurnChanges";
createRoot(dispose=>{
 const [sid,setSid]=createSignal("s");const sent:any[]=[];let choice="resend";let choose:((v:string)=>void)|undefined;let waitChoice=false;
 const t=createTranscript({send:p=>sent.push(p),isOpen:()=>true,getSessionId:sid,getHostId:()=>"h",toast:()=>{},showChoice:()=>waitChoice?new Promise<string>(resolve=>choose=resolve):Promise.resolve(choice),onTurnIdle:()=>{},onUsageContext:()=>{}});
 let confirmUndo:(v:boolean)=>void=()=>{};
 const undo=createTurnChanges({send:p=>sent.push(p),getSessionId:sid,toast:()=>{},showConfirm:()=>new Promise(resolve=>confirmUndo=resolve)});
 const bg=createBackground({send:()=>{},isOpen:()=>true,getSessionId:sid,toast:()=>{}});
 let offline=false;
 const layer=createDataLayer({isOpen:()=>true,send:cmd=>{if(cmd.type!=="pull" || typeof cmd.id!=="number")return;const id=cmd.id;setTimeout(()=>layer.handleMessage(offline?{type:"error",hostId:"h",id,replyTo:"pull",message:"Remote host is offline"}:{type:"pull-response",hostId:"h",id,items:cmd.collection==="sessions"?[{id:"s",title:"Saved session",createdAt:1,updatedAt:1}]:[]}),0)}});
 Object.assign(window,{flowRegression:{t,bg,layer,sent,setSid,undo,confirmUndo:(v:boolean)=>confirmUndo(v),setChoice:(c:string)=>choice=c,deferChoice:()=>waitChoice=true,choose:(c:string)=>{waitChoice=false;choose?.(c)},offline:()=>offline=true,dispose}});
});
