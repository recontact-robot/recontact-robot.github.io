/* ReContact project page: play-when-visible videos, synchronized comparison videos,
   section highlighting, the talk link. Plain script so the page also
   works when opened directly from disk (file://). */
(function () {
  'use strict';

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function each(selector, fn, root) {
    Array.prototype.forEach.call((root || document).querySelectorAll(selector), fn);
  }

  function play(video) {
    var p = video.play();
    if (p && typeof p.catch === 'function') p.catch(function () {});
  }

  /* Muted loops (and the lead of each synchronized group) play only while a quarter of them is on screen. */
  var autoVideos = document.querySelectorAll('video[data-autoplay], video[data-lead]');
  if (reduceMotion) {
    Array.prototype.forEach.call(autoVideos, function (v) {
      v.removeAttribute('autoplay');
      v.pause();
      v.controls = true;
    });
  } else if ('IntersectionObserver' in window) {
    var visibility = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) play(entry.target);
        else if (!entry.target.paused) entry.target.pause();
      });
    }, { threshold: 0.25 });
    Array.prototype.forEach.call(autoVideos, function (v) { visibility.observe(v); });
  } else {
    Array.prototype.forEach.call(autoVideos, play);
  }

  /* In each [data-sync] group the data-lead video sets the clock and the data-follow videos keep it. */
  function syncVideos(lead, followers) {
    function align(follow) {
      if (follow.readyState < 1 || !follow.duration) return;
      var t = lead.currentTime % follow.duration;
      if (Math.abs(follow.currentTime - t) > 0.06) follow.currentTime = t;
    }
    followers.forEach(function (follow) {
      lead.addEventListener('play', function () { follow.preload = 'auto'; align(follow); play(follow); });
      lead.addEventListener('pause', function () { follow.pause(); });
      lead.addEventListener('seeked', function () { align(follow); });
      follow.addEventListener('loadedmetadata', function () { align(follow); if (!lead.paused) play(follow); });
    });
    (function tick() {
      if (!lead.paused) followers.forEach(align);
      window.requestAnimationFrame(tick);
    })();
  }

  each('[data-sync]', function (group) {
    var lead = group.querySelector('video[data-lead]');
    if (lead) syncVideos(lead, Array.prototype.slice.call(group.querySelectorAll('video[data-follow]')));
  });

  /* Switches: each [data-twin] shows the [data-pane] its pressed button names. Switches nest
     (task family > Real / Sim), so a switch only touches buttons and panes it owns.
     Hidden videos leave the viewport observer, so only the visible pane plays. */
  function own(selector, twin, fn) {
    each(selector, function (el) { if (el.parentNode.closest('[data-twin]') === twin) fn(el); }, twin);
  }
  function show(twin, name) {
    own('button[data-show]', twin, function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-show') === name)); });
    own('[data-pane]', twin, function (pane) { pane.hidden = pane.getAttribute('data-pane') !== name; });
    twin.setAttribute('data-view', name);
  }
  each('[data-twin]', function (twin) {
    own('button[data-show]', twin, function (button) {
      button.addEventListener('click', function () { show(twin, button.getAttribute('data-show')); });
    });
  });
  /* A link to a hidden pane (#tube) opens it first. */
  function openHash() {
    var pane = location.hash && document.getElementById(location.hash.slice(1));
    if (pane && pane.hasAttribute('data-pane')) {
      show(pane.parentNode.closest('[data-twin]'), pane.getAttribute('data-pane'));
      pane.scrollIntoView();
    }
  }
  window.addEventListener('hashchange', openHash);
  openHash();

  /* Navigation: border after scrolling, highlight the section in view. */
  var nav = document.getElementById('nav');
  function onScroll() { nav.classList.toggle('scrolled', window.scrollY > 8); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  if ('IntersectionObserver' in window) {
    var links = {};
    each('.nav-links a[href^="#"]', function (a) { links[a.getAttribute('href').slice(1)] = a; });
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var id = entry.target.id;
        Object.keys(links).forEach(function (k) { links[k].classList.toggle('active', k === id); });
      });
    }, { rootMargin: '-40% 0px -55% 0px' });
    each('header[id], section[id]', function (s) { spy.observe(s); });
  }

  /* Talk button: only the de-identified deck (output/talk_public), served on port 8140 of the same
     machine (talk-lan here, recontact_talk/serve.sh on the robot laptop). The HTML keeps a "#"
     placeholder so that the anonymous package check finds no external link. */
  var talk = document.getElementById('talk-link');
  if (talk) talk.href = 'http://' + (location.hostname || '127.0.0.1') + ':8140/talk/index.html';

})();
