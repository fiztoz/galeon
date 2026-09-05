import {test, expect} from 'bun:test';
import {hookHarness} from './harness';
const harness=hookHarness();
const listeners=new Map<string, {fn: (event:any)=>void; capture: boolean}>();
Object.assign(globalThis, {document:{
  addEventListener(name:string,fn:(event:any)=>void,capture=false) {listeners.set(name,{fn,capture});},
  removeEventListener(name:string,fn:(event:any)=>void,capture=false) {const saved=listeners.get(name); expect(saved?.fn).toBe(fn);expect(saved?.capture).toBe(capture);listeners.delete(name);},
}});
const {ObjectContextMenu}=await import('../../src/components/ObjectContextMenu');
test('menu closes on outside click, context menu, nested scroll and Escape; listeners clean up',()=>{
 let closes=0;
 harness.render(()=>ObjectContextMenu({obj:{name:'test',fullKey:'test',objectType:'file',sizeBytes:1,lastModified:null},menuPosition:{x:1,y:1},onAction:()=>{},onClose:()=>{closes++;}}));
 listeners.get('keydown')!.fn({key:'Enter'});expect(closes).toBe(0);
 listeners.get('keydown')!.fn({key:'Escape'});
 for(const name of ['click','contextmenu','scroll']) listeners.get(name)!.fn({});
 expect(closes).toBe(4);expect(listeners.get('scroll')!.capture).toBe(true);
 harness.unmount();expect(listeners.size).toBe(0);
});
