/* ===== Soccer Flow — script.js ===== */
/* Progressive enhancement only: FAQ accordion, smooth scroll,
   sticky header shadow, floating WhatsApp button. Site works without JS. */

(function () {
  "use strict";

  var prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ----- FAQ accordion ----- */
  var questions = document.querySelectorAll(".faq-question");
  questions.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var expanded = btn.getAttribute("aria-expanded") === "true";
      var answer = document.getElementById(btn.getAttribute("aria-controls"));
      btn.setAttribute("aria-expanded", String(!expanded));
      if (answer) {
        answer.hidden = expanded;
      }
    });
  });

  /* ----- Smooth scroll for in-page anchors ----- */
  document.querySelectorAll('a[href^="#"]').forEach(function (link) {
    link.addEventListener("click", function (event) {
      var id = link.getAttribute("href");
      if (id.length < 2) return;
      var target = document.querySelector(id);
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({
        behavior: prefersReducedMotion ? "auto" : "smooth",
        block: "start"
      });
      // Move focus for keyboard/screen-reader users without re-scrolling
      target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
    });
  });

  /* ----- Sticky header shadow + floating WhatsApp button ----- */
  var header = document.getElementById("site-header");
  var whatsappFloat = document.getElementById("whatsapp-float");

  function onScroll() {
    var scrolled = window.scrollY > 8;
    if (header) {
      header.classList.toggle("scrolled", scrolled);
    }
    if (whatsappFloat) {
      // Show after the visitor scrolls past the hero
      whatsappFloat.classList.toggle("visible", window.scrollY > 400);
    }
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ----- Footer year ----- */
  var yearEl = document.getElementById("footer-year");
  if (yearEl) {
    yearEl.textContent = String(new Date().getFullYear());
  }
})();
