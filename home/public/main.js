const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const reveals = document.querySelectorAll('.reveal');
if (reduce || !('IntersectionObserver' in window)) {
  reveals.forEach((el) => el.classList.add('in'));
} else {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }
  }, { threshold: 0.15 });
  reveals.forEach((el) => io.observe(el));
}

const video = document.getElementById('promo');
const fallback = document.getElementById('videoFallback');
const showFallback = () => { video.hidden = true; fallback.hidden = false; };
video.addEventListener('error', showFallback);
video.querySelector('source')?.addEventListener('error', showFallback);
fetch('assets/promo.mp4', { method: 'HEAD' }).then((r) => { if (!r.ok) showFallback(); }).catch(showFallback);