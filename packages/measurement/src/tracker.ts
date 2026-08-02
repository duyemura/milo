/**
 * milo-track — the engagement events no gym will ever configure, injected ahead of /body.
 * All events land in GA4 (via the injected gtag) with the page's site/workspace params.
 * Funnel mapping: visited=page_view | engaged=engaged_15s | intent=intent_click | converted=form_submit.
 */
export const TRACKER_MARKER = "milo-track:v1";

export function trackerScript(): string {
  return `<script data-milo="track">${TRACKER_MARKER}
(function(){
  if(!window.gtag)return;
  var ev=function(n,p){try{gtag('event',n,p||{})}catch(e){}};
  // engaged at 15s and 45s
  setTimeout(function(){ev('engaged_15s')},15000);
  setTimeout(function(){ev('engaged_45s')},45000);
  // scroll milestones
  var marks=[25,50,75,90],seen={};
  function scroll(){
    var h=document.documentElement;
    var p=Math.round((h.scrollTop+window.innerHeight)/Math.max(h.scrollHeight,1)*100);
    for(var i=0;i<marks.length;i++){
      if(p>=marks[i]&&!seen[marks[i]]){seen[marks[i]]=1;gtag('event','scroll_'+marks[i]);}
    }
  }
  window.addEventListener('scroll',scroll,{passive:true});
  scroll();
  // intent clicks: bookings, classes, pricing, tel/mailto
  var INTENT=/\\b(book|trial|join|class|schedule|pricing|sign.?up|contact|plan)\\b/i;
  document.addEventListener('click',function(e){
    var a=e.target&&e.target.closest?e.target.closest('a,[data-pc],[data-cta],[role="button"],button'):null;
    if(!a)return;
    var href=a.getAttribute&&a.getAttribute('href')||'';
    var isIntent=INTENT.test(href)||INTENT.test(a.textContent||'')||INTENT.test(a.className||'')||/^tel:|^mailto:/i.test(href)||a.hasAttribute('data-cta');
    if(isIntent)gtag('event','intent_click',{label:(href||a.textContent||'').slice(0,80)});
  },true);
  // form submits → converted
  document.addEventListener('submit',function(e){
    var f=e.target;var id=f.getAttribute('id')||f.getAttribute('name')||'form';
    gtag('event','form_submit',{form:id});
  },true);
})();
</script>`;
}

/** Inject the tracker right before </head> (after gtag config, which injectGtag anchors at <head> start). */
export function injectTracker(html: string): { html: string; changed: boolean } {
  if (html.includes(TRACKER_MARKER)) return { html, changed: false };
  const idx = html.search(/<\/head>/i);
  if (idx === -1) return { html, changed: false };
  return {
    html: html.slice(0, idx) + trackerScript() + "\n" + html.slice(idx),
    changed: true,
  };
}
