/**
 * iOS focus-zoom guard.
 *
 * iOS Safari zooms the page when a field under 16px takes focus. Inline edit
 * fields inherit the size of the text they replace (so editing moves nothing),
 * and much of that text is smaller than 16px. Adding `maximum-scale=1` stops
 * the focus zoom; iOS still honours pinch zoom regardless of it. Other
 * platforms treat `maximum-scale` as a pinch-zoom lock, so it is added on iOS
 * only. Runs after the viewport meta is in the document.
 */
export const IOS_FOCUS_ZOOM_BOOT_SCRIPT = `(function(){try{var n=navigator;if(!(/iP(hone|ad|od)/.test(n.userAgent)||(n.platform==="MacIntel"&&n.maxTouchPoints>1)))return;var m=document.querySelector('meta[name="viewport"]');if(m&&m.content.indexOf("maximum-scale")<0)m.content+=", maximum-scale=1";}catch(e){}})();`;
