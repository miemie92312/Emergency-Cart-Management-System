// 旧版没有更新提示。仅在本作用域确实命中旧缓存时接管；不刷新正在填写的旧页面，不触碰数据库。
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const name='rescue-cart-demo-v1';
  if(!(await caches.keys()).includes(name))return;
  const cache=await caches.open(name),keys=await cache.keys();
  if(keys.some(req=>req.url.startsWith(self.registration.scope)))await self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  const name='rescue-cart-demo-v1';
  if(!(await caches.keys()).includes(name))return;
  const cache=await caches.open(name),keys=await cache.keys();
  for(const req of keys)if(req.url.startsWith(self.registration.scope))await cache.delete(req);
  if(!(await cache.keys()).length)await caches.delete(name);
})()));
