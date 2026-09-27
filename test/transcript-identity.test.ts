import { expect, test } from "bun:test";
import { appendToolResult, mergeAssistantMessage, normalizeSessionMessages } from "../web/src/indirect-code/transcript/updaters";
import type { ChatMessage } from "../web/src/indirect-code/types";

const assistant = (id: string, index: number, text = ""): ChatMessage => ({ id, srcIdx:index, role:"assistant", time:1, blocks:[{type:"text",text}] });

test("daemon message identity survives normalization and index reuse", () => {
 const before = [assistant("old", 1)];
 const next = normalizeSessionMessages([{id:"new", role:"assistant", content:[{text:"replacement"}]}], before, 1);
 expect(next[0].id).toBe("new");
});

test("a late assistant completion updates its own carrier without replacing the next one", () => {
 const prev = [assistant("a",1,"partial"), assistant("b",3,"new response")];
 const next = mergeAssistantMessage(prev,{index:1,message:{id:"a",role:"assistant",content:[{text:"complete"}]}});
 expect(next.map(m=>m.id)).toEqual(["a","b"]);
 expect(next[0].blocks[0].text).toBe("complete");
 expect(next[1].blocks[0].text).toBe("new response");
});

test("tool result replay is idempotent and targets the original call", () => {
 const a = assistant("a",1); a.blocks=[{type:"tool_call",toolId:"call",toolName:"bash"}];
 const b = assistant("b",3,"later");
 let messages = appendToolResult([a,b],"call","done");
 messages = appendToolResult(messages,"call","done");
 expect(messages[0].blocks.filter(b=>b.type==="tool_result")).toHaveLength(1);
 expect(messages[1]).toBe(b);
});

test("assistant completion replay retains an already delivered tool result", () => {
 const a=assistant("a",1); a.blocks=[{type:"tool_call",toolId:"call",toolName:"bash"}];
 const messages=appendToolResult([a],"call","done");
 const next=mergeAssistantMessage(messages,{index:1,message:{id:"a",role:"assistant",content:[{id:"call",name:"bash",arguments:{}}]}});
 expect(next[0].blocks.filter(b=>b.type==="tool_result")).toHaveLength(1);
});

import { createTranscriptOrder } from "../web/src/indirect-code/transcript/order";
import { mergeTranscriptTail } from "../web/src/indirect-code/transcript/updaters";

test("a tail snapshot replaces retried rows while preserving older pages",()=>{
 const prev=[assistant("history",1),assistant("discarded",8),assistant("current",9)];
 const next=mergeTranscriptTail(prev,[assistant("new",8)],8);
 expect(next.map(m=>m.id)).toEqual(["history","new"]);
});

test("a delayed snapshot replays only subsequent events once",()=>{
 let text="",requests=0;
 const order=createTranscriptOrder(()=>requests++);
 expect(order.snapshot({stream:"one",seq:4})).toEqual([]);
 order.event({stream:"one",seq:5},()=>text+="A");
 order.event({stream:"one",seq:6},()=>text+="B");
 order.event({stream:"one",seq:6},()=>text+="duplicate");
 text="snapshot:";
 for(const apply of order.snapshot({stream:"one",seq:5})!) apply();
 expect(text).toBe("snapshot:B");
 expect(requests).toBe(0);
});

test("missing events stop guessed updates and recover from a snapshot",()=>{
 let text="",requests=0;
 const order=createTranscriptOrder(()=>requests++);
 order.snapshot({stream:"one",seq:1});
 order.event({stream:"one",seq:3},()=>text+="C");
 order.event({stream:"one",seq:4},()=>text+="D");
 expect(text).toBe(""); expect(requests).toBe(1);
 text="AB";
 for(const apply of order.snapshot({stream:"one",seq:2})!) apply();
 expect(text).toBe("ABCD");
});

test("a snapshot older than the bounded replay window requests a fresh snapshot",()=>{
 let text="",requests=0;
 const order=createTranscriptOrder(()=>requests++,2);
 order.snapshot({stream:"one",seq:0});
 for(let seq=1;seq<=4;seq++) order.event({stream:"one",seq},()=>text+=seq);
 expect(text).toBe("1234");
 expect(order.snapshot({stream:"one",seq:1})).toBeNull();
 expect(requests).toBe(1);
 expect(order.snapshot({stream:"one",seq:4})).toEqual([]);
 order.event({stream:"one",seq:5},()=>text+="5");
 expect(text).toBe("12345");
});

test("old actor events cannot affect a replacement actor at the same indices",()=>{
 let text="";
 const order=createTranscriptOrder(()=>{});
 order.snapshot({stream:"old",seq:10});
 order.snapshot({stream:"new",seq:1});
 order.event({stream:"old",seq:11},()=>text+="stale");
 expect(order.snapshot({stream:"old",seq:12})).toBeNull();
 order.event({stream:"new",seq:2},()=>text+="new");
 expect(text).toBe("new");
});

test("normalization attaches a delayed result to its call across an intervening user message",()=>{
 const messages=normalizeSessionMessages([
  {id:"a",role:"assistant",content:[{id:"call",name:"bash",arguments:{}}]},
  {id:"u",role:"user",content:[{text:"next"}]},
  {id:"r",role:"tool",content:[{call_id:"call",content:[{text:"done"}]}]},
 ]);
 expect(messages.map(m=>m.id)).toEqual(["a","u"]);
 expect(messages[0].blocks.filter(b=>b.type==="tool_result")).toHaveLength(1);
});
