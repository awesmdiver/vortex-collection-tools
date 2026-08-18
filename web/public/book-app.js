'use strict';
// Get Started book (Skyrim-only) -- fetches its own themes/skyrim-book.json (a theme.js concern
// would be a layering violation: theme.js only ever fills brand-slot markup already in the DOM, it
// doesn't own whole new page content like this). Content: design/get-started-book-content-draft-v1-
// Gemini.md is the source; skyrim-book.json is the built/structured form of it. Names/emoji/function
// labels are deliberately NOT duplicated here -- pulled live from window.activeTheme.tools at render
// time, same single-source-of-truth the rest of the theming system already follows.

function $bk(id) { return document.getElementById(id); }

let bookData = null; // { title, chapters: [{ toolId, banner, lore, whatItDoes }, ...] }
let bookLoaded = false;

function bookLoadOnce(forceChapter) {
  // forceChapter (a chapter's toolId) wins over the URL's own ?chapter= -- used by a live click that
  // wants a SPECIFIC chapter (e.g. Home's banner/title jumping straight to the "home" chapter)
  // regardless of whatever the address bar currently says.
  const chapterParam = forceChapter || new URLSearchParams(location.search).get('chapter');
  const refParam = !forceChapter && new URLSearchParams(location.search).get('ref');
  if (bookLoaded) {
    // Already loaded (e.g. returning to this area via the header link, not a fresh page load) --
    // a ?chapter=/?ref= param still jumps straight there instead of always landing on the ToC.
    if (chapterParam) bookShowChapter(chapterParam);
    else if (refParam) bookShowReference();
    return;
  }
  bookLoaded = true;
  fetch('/themes/skyrim-book.json')
    .then((r) => r.json())
    .then((data) => {
      bookData = data;
      bookRenderToc();
      if (chapterParam) bookShowChapter(chapterParam);
      else if (refParam) bookShowReference();
    })
    .catch(() => {
      // No book for the active theme (Plain, or the fetch genuinely failed) -- the nav-book button
      // that's the only way to reach this area is already hidden for Plain via CSS, so a failure
      // here is either a real network hiccup or someone forced the URL directly. Either way, leave
      // the static "table of contents" shell as-is rather than showing a broken/empty page.
    });
}
window.bookLoadOnce = bookLoadOnce;

function bookToolName(toolId) {
  const t = window.activeTheme && window.activeTheme.tools && window.activeTheme.tools[toolId];
  return t ? t.name : toolId;
}
function bookToolEmoji(toolId) {
  const t = window.activeTheme && window.activeTheme.tools && window.activeTheme.tools[toolId];
  return t && t.emoji ? t.emoji : '';
}
function bookToolFunction(toolId) {
  const t = window.activeTheme && window.activeTheme.tools && window.activeTheme.tools[toolId];
  return t ? t.function : '';
}

function bookRenderToc() {
  $bk('bookTocList').innerHTML = bookData.chapters.map((ch) => {
    const name = bookToolName(ch.toolId);
    const emoji = bookToolEmoji(ch.toolId);
    return `<a class="book-toc__link" data-tool-id="${ch.toolId}">${emoji ? emoji + ' ' : ''}${name}</a>`;
  }).join('');
  $bk('bookTocList').querySelectorAll('.book-toc__link').forEach((a) => {
    a.addEventListener('click', () => bookShowChapter(a.dataset.toolId));
  });
}

function bookShowChapter(toolId) {
  if (!bookData) return;
  const idx = bookData.chapters.findIndex((c) => c.toolId === toolId);
  if (idx === -1) return;
  const ch = bookData.chapters[idx];

  $bk('bookToc').classList.add('hidden');
  $bk('bookChapter').classList.remove('hidden');

  $bk('bookChapterBanner').src = `/${ch.banner}`;
  $bk('bookChapterEyebrow').textContent = `Chapter · ${bookToolFunction(toolId)}`;
  const emoji = bookToolEmoji(toolId);
  $bk('bookChapterTitle').textContent = (emoji ? emoji + ' ' : '') + bookToolName(toolId);
  $bk('bookChapterFunc').textContent = `Functional name: ${bookToolFunction(toolId)}`;
  $bk('bookChapterLore').innerHTML = ch.lore;
  $bk('bookChapterWhatItDoes').innerHTML = ch.whatItDoes;
  $bk('bookChapterPos').textContent = `${idx + 1} of ${bookData.chapters.length}`;

  const prevBtn = $bk('bookPrevBtn');
  const nextBtn = $bk('bookNextBtn');
  const prev = bookData.chapters[idx - 1];
  const next = bookData.chapters[idx + 1];
  prevBtn.textContent = prev ? `← ${bookToolName(prev.toolId)}` : '';
  prevBtn.disabled = !prev;
  nextBtn.textContent = next ? `${bookToolName(next.toolId)} →` : '';
  nextBtn.disabled = !next;

  // Keeps the URL shareable/refreshable to this exact chapter, same "update the address bar without
  // a real navigation" convention the log-view page's own status filter already uses.
  const url = new URL(location.href);
  url.searchParams.set('area', 'book');
  url.searchParams.set('chapter', toolId);
  history.replaceState(null, '', url);
}

$bk('bookPrevBtn').addEventListener('click', () => {
  const current = new URLSearchParams(location.search).get('chapter');
  const idx = bookData.chapters.findIndex((c) => c.toolId === current);
  if (idx > 0) bookShowChapter(bookData.chapters[idx - 1].toolId);
});
$bk('bookNextBtn').addEventListener('click', () => {
  const current = new URLSearchParams(location.search).get('chapter');
  const idx = bookData.chapters.findIndex((c) => c.toolId === current);
  if (idx >= 0 && idx < bookData.chapters.length - 1) bookShowChapter(bookData.chapters[idx + 1].toolId);
});
function bookGoToToc() {
  $bk('bookChapter').classList.add('hidden');
  $bk('bookReference').classList.add('hidden');
  $bk('bookToc').classList.remove('hidden');
  const url = new URL(location.href);
  url.searchParams.delete('chapter');
  url.searchParams.delete('ref');
  history.replaceState(null, '', url);
}
$bk('bookBackToToc').addEventListener('click', bookGoToToc);
$bk('bookBackToTocFromRef').addEventListener('click', bookGoToToc);

// ---- Name reference: standard <-> themed, one row per book chapter (same tool set/order as the
// ToC) -- a plain lookup table, not a "chapter" about any single tool, so it gets its own view
// rather than being squeezed into the chapter page's parchment layout.
function bookRenderReference() {
  $bk('bookRefRows').innerHTML = bookData.chapters.map((ch) => {
    const emoji = bookToolEmoji(ch.toolId);
    const themedName = (emoji ? emoji + ' ' : '') + bookToolName(ch.toolId);
    return `<tr><td>${bookToolFunction(ch.toolId)}</td><td>${themedName}</td></tr>`;
  }).join('');
}

function bookShowReference() {
  if (!bookData) return;
  bookRenderReference();
  $bk('bookToc').classList.add('hidden');
  $bk('bookChapter').classList.add('hidden');
  $bk('bookReference').classList.remove('hidden');
  const url = new URL(location.href);
  url.searchParams.set('area', 'book');
  url.searchParams.set('ref', '1');
  url.searchParams.delete('chapter');
  history.replaceState(null, '', url);
}
$bk('bookRefLink').addEventListener('click', (e) => { e.preventDefault(); bookShowReference(); });
