/* Soccer Flow — progressive enhancement.
   FAQ accordion + IntersectionObserver reveals + footer year. No deps. */

(function () {
  "use strict";
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // FAQ accordion (single-open behavior).
  var faqItems = document.querySelectorAll(".faq-item");
  faqItems.forEach(function (item) {
    var btn = item.querySelector(".faq-q");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var alreadyOpen = item.classList.contains("open");
      faqItems.forEach(function (other) {
        other.classList.remove("open");
        var otherBtn = other.querySelector(".faq-q");
        if (otherBtn) otherBtn.setAttribute("aria-expanded", "false");
      });
      if (!alreadyOpen) {
        item.classList.add("open");
        btn.setAttribute("aria-expanded", "true");
      }
    });
  });

  // Smooth anchor scroll.
  document.querySelectorAll('a[href^="#"]').forEach(function (link) {
    link.addEventListener("click", function (event) {
      var id = link.getAttribute("href");
      if (!id || id.length < 2) return;
      var target = document.querySelector(id);
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({
        behavior: reduce ? "auto" : "smooth",
        block: "start"
      });
    });
  });

  // Reveal-on-scroll for [data-reveal] elements.
  if ("IntersectionObserver" in window && !reduce) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
    document.querySelectorAll("[data-reveal]").forEach(function (el) {
      io.observe(el);
    });
  } else {
    document.querySelectorAll("[data-reveal]").forEach(function (el) {
      el.classList.add("in");
    });
  }

  // Footer year.
  var y = document.getElementById("footer-year");
  if (y) y.textContent = String(new Date().getFullYear());

  /* ----- Hero parallax (subtle, decorative layers only) -----
     Photo drifts up slower than scroll; monogram drifts up faster;
     tile floats slightly opposite. Reads as depth without moving text.
     Guarded by reduced-motion and by hero visibility (no work when off-screen).
  */
  var hero = document.querySelector(".hero");
  if (hero && !reduce) {
    // Parallax on wrappers only, so inner CSS animations (Ken Burns,
    // tile pop-in, stamp wobble) keep running untouched.
    var photoLayer = hero.querySelector(".hero-photo");
    var monogram   = hero.querySelector(".hero-monogram");
    var visible    = true;
    var ticking    = false;

    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
      }, { threshold: 0 }).observe(hero);
    }

    [photoLayer, monogram].forEach(function (el) {
      if (el) el.style.willChange = "transform";
    });

    function paint() {
      ticking = false;
      var y = window.scrollY;
      if (photoLayer) photoLayer.style.transform = "translate3d(0, " + (y * 0.08) + "px, 0)";
      if (monogram)   monogram.style.transform   = "translate3d(0, " + (y * -0.15) + "px, 0)";
    }

    window.addEventListener("scroll", function () {
      if (!visible || ticking) return;
      ticking = true;
      requestAnimationFrame(paint);
    }, { passive: true });
    paint();
  }

})();
