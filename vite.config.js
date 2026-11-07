import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve } from 'node:path';
export default defineConfig({
  base:process.env.APP_BASE||'./',
  plugins:[VitePWA({
    registerType:'prompt',filename:'sw.js',injectRegister:false,
    includeAssets:['icons/*.png','icons/*.svg'],
    manifest:{id:'./',name:'抢救车管理助手',short_name:'抢救车助手',description:'护士个人使用的本地抢救车管理辅助工作台',lang:'zh-CN',start_url:'./',scope:'./',display:'standalone',background_color:'#f2f5f6',theme_color:'#195b70',icons:[{src:'icons/icon-192.png',sizes:'192x192',type:'image/png'},{src:'icons/icon-512.png',sizes:'512x512',type:'image/png'},{src:'icons/maskable-512.png',sizes:'512x512',type:'image/png',purpose:'maskable'}]},
    workbox:{globPatterns:['**/*.{html,js,css,png,svg,webmanifest}'],maximumFileSizeToCacheInBytes:5*1024*1024,navigateFallback:'index.html',cleanupOutdatedCaches:true,clientsClaim:true,skipWaiting:false,importScripts:['./legacy-cache-bridge.js']},
    devOptions:{enabled:false}
  })],
  build:{rollupOptions:{input:{main:resolve(import.meta.dirname,'index.html'),legacy:resolve(import.meta.dirname,'legacy/index.html')}}},
  test:{environment:'node',include:['tests/**/*.test.js']}
});
