(function(){
var __ELLUL_POP_SEED__=1;
var DB='sovereign-shield',ST='session-keys',VER=2;
var K='__K_POP__',D='__DEVICE_ID__';
try{
  var r=indexedDB.open(DB,VER);
  r.onupgradeneeded=function(e){var db=e.target.result;if(!db.objectStoreNames.contains(ST))db.createObjectStore(ST,{keyPath:'id'});};
  r.onsuccess=function(){var db=r.result;try{var tx=db.transaction(ST,'readwrite');var s=tx.objectStore(ST);s.put({id:'current',hmacKey:K,createdAt:Date.now()});s.put({id:'device-id',deviceId:D,createdAt:Date.now()});}catch(e){}};
}catch(e){}
var rf=window.fetch;
window.fetch=function(i,o){
  try{var u=new URL(i,location.origin);if(u.pathname==='/_auth/pop/bind/init')return Promise.resolve(new Response(JSON.stringify({bound:true,existing:true}),{status:200,headers:{'Content-Type':'application/json'}}));}catch(e){}
  return rf.apply(this,arguments);
};
})();
