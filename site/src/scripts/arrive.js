/* Arrival and idling.
 *
 * Each frame rises in once, as it comes into view: crew.css hides the listed elements of a frame
 * that has not arrived yet (only while html.can-rise is set, which the page sets before its first
 * paint, and only with motion allowed) and animates them in, staggered by --r, once the frame
 * carries .is-arrived. If this script never runs, the page's inline switch takes can-rise back off
 * after 3 seconds, so nothing can stay hidden.
 *
 * Every frame also carries .is-live while it is on screen; the decorative loops (the phase pulse,
 * the sandbox packet and pulse, the workflow dot) pause while their frame is off screen. */

window.__crewArrive = true;
const html = document.documentElement;
const frames = Array.prototype.slice.call(document.querySelectorAll('[data-frame], .same-garden'));
const RISE = '.hero-kicker, .hero-head h1, .lede, .job, .beat, .sec h2, .sec .sub, .sec .lead, .pull, .end-line, .benefit, .sbx, .disp, .rcx, .wf, .facts--row, .facts--cards li, .get-intro, .install-stack, .gh-pill, .sg-head, .sg-plane';

frames.forEach((f) => {
  Array.prototype.slice.call(f.querySelectorAll(RISE)).forEach((el, k) => el.style.setProperty('--r', String(Math.min(k, 8))));
});

if (!('IntersectionObserver' in window)) {
  frames.forEach((f) => f.classList.add('is-arrived', 'is-live'));
} else {
  if (html.classList.contains('can-rise')) {
    const arrive = new IntersectionObserver((es) => es.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add('is-arrived'); arrive.unobserve(e.target); }
    }), { threshold: 0.3 });
    frames.forEach((f) => arrive.observe(f));
  } else {
    frames.forEach((f) => f.classList.add('is-arrived'));
  }
  const live = new IntersectionObserver((es) => es.forEach((e) => e.target.classList.toggle('is-live', e.isIntersecting)), { threshold: 0 });
  frames.forEach((f) => live.observe(f));
}
