// ---------- Campo de estrellas animado ----------
const canvas = document.getElementById("starfield");
const ctx = canvas.getContext("2d");
let stars = [];
let w, h;

function resize() {
  w = canvas.width = window.innerWidth;
  h = canvas.height = window.innerHeight;
  const count = Math.floor((w * h) / 3500);
  stars = Array.from({ length: count }, () => ({
    x: Math.random() * w,
    y: Math.random() * h,
    r: Math.random() * 1.4 + 0.2,
    a: Math.random(),
    s: Math.random() * 0.02 + 0.005,
    depth: Math.random() * 0.5 + 0.1,
  }));
}

let scrollY = 0;
function draw() {
  ctx.clearRect(0, 0, w, h);
  for (const st of stars) {
    st.a += st.s;
    const alpha = 0.4 + Math.abs(Math.sin(st.a)) * 0.6;
    const y = (st.y - scrollY * st.depth) % h;
    ctx.beginPath();
    ctx.arc(st.x, y < 0 ? y + h : y, st.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${alpha})`;
    ctx.fill();
  }
  requestAnimationFrame(draw);
}

window.addEventListener("resize", resize);
resize();
draw();

// ---------- Navegación ----------
const nav = document.getElementById("nav");
window.addEventListener("scroll", () => {
  scrollY = window.scrollY;
  nav.classList.toggle("scrolled", window.scrollY > 40);
});

const toggle = document.getElementById("navToggle");
const links = document.getElementById("navLinks");
toggle.addEventListener("click", () => links.classList.toggle("open"));
links.querySelectorAll("a").forEach((a) =>
  a.addEventListener("click", () => links.classList.remove("open"))
);

// ---------- Animación al hacer scroll ----------
const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) {
        e.target.classList.add("visible");
        observer.unobserve(e.target);
      }
    });
  },
  { threshold: 0.15 }
);
document.querySelectorAll(".reveal").forEach((el) => observer.observe(el));
