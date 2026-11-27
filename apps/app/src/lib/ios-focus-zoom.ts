// Add maximum-scale=1 only on iOS; other platforms would lock pinch zoom
export const IOS_FOCUS_ZOOM_BOOT_SCRIPT = `(function(){try{var n=navigator;if(!(/iP(hone|ad|od)/.test(n.userAgent)||(n.platform==="MacIntel"&&n.maxTouchPoints>1)))return;var m=document.querySelector('meta[name="viewport"]');if(m&&m.content.indexOf("maximum-scale")<0)m.content+=", maximum-scale=1";}catch(e){}})();`;
