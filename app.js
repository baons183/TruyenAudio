(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const fileInput = $("#file-input");
  const viewer = $("#viewer");
  const welcomeCard = $("#welcome-card");
  const loadingState = $("#loading-state");
  const readerError = $("#reader-error");
  const tocList = $("#toc-list");
  const playButton = $("#play-button");
  const stopButton = $("#stop-button");
  const voiceSelect = $("#voice-select");
  const speechStatus = $("#speech-status");
  const audioIllustration = $("#audio-illustration");
  // Trong app iOS/Android (Capacitor), giọng trên máy đi qua plugin native ReaderSpeech
  // để nghe được khi gạt im lặng, tắt màn hình và tự chuyển chương khi chạy nền.
  const nativeSpeech = window.capacitorExports?.Capacitor?.isNativePlatform?.()
    ? window.capacitorExports.registerPlugin("ReaderSpeech")
    : null;
  let nativeVoices = [];
  let nativeState = "stopped";
  let nativeLoadToken = 0;
  const synth = nativeSpeech ? null : window.speechSynthesis;
  const audioPlayer = new Audio();
  const defaultReaderPreferences = {
    fontFamily: "georgia",
    fontSize: 100,
    lineHeight: 1.85,
    margin: 16,
    textColor: "#35372f",
    backgroundColor: "#fffefa",
    brightness: null,
    theme: "light",
  };
  // Mỗi giao diện có bộ màu trang sách riêng; đổi giao diện thì màu chữ/nền đổi theo.
  const readerThemes = {
    light: { label: "Sáng", textColor: "#35372f", backgroundColor: "#fffefa" },
    sepia: { label: "Ngà", textColor: "#4a3d2c", backgroundColor: "#f6eedc" },
    dark: { label: "Tối", textColor: "#d9d6ca", backgroundColor: "#1e211c" },
  };
  const readerThemeOrder = ["light", "sepia", "dark"];
  const readerFontFamilies = {
    georgia: "Georgia, 'Times New Roman', serif",
    arial: "Arial, Helvetica, sans-serif",
    times: "'Times New Roman', Times, serif",
    verdana: "Verdana, Geneva, sans-serif",
    mono: "Consolas, 'Courier New', monospace",
  };

  let book = null;
  let rendition = null;
  let currentFileName = "";
  let currentChapter = "";
  let currentProgress = 0;
  let voices = [];
  let speechQueue = [];
  let speechIndex = 0;
  let currentUtterance = null;
  let usingOnlineVoice = false;
  let isPaused = false;
  let readerPreferences = { ...defaultReaderPreferences };
  let fontSize = readerPreferences.fontSize;
  let currentBookId = "";
  let currentSpineIndex = null;
  let readingMode = "scrolled-doc";
  let savePositionTimer = 0;
  let readerChromeTimer = 0;
  const readerGestureDocuments = new WeakSet();
  const tocLabelsBySpineIndex = new Map();
  let storagePromise;

  function openStorage() {
    if (!("indexedDB" in window)) {
      return Promise.reject(new Error("Trình duyệt này không hỗ trợ lưu sách trên thiết bị."));
    }
    if (!storagePromise) {
      storagePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open("trang-doc-library", 1);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains("books")) {
            database.createObjectStore("books", { keyPath: "id" });
          }
          if (!database.objectStoreNames.contains("settings")) {
            database.createObjectStore("settings", { keyPath: "key" });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Không mở được thư viện sách trên thiết bị."));
      });
    }
    return storagePromise;
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Không truy cập được dữ liệu sách đã lưu."));
    });
  }

  function transactionComplete(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("Không lưu được dữ liệu sách."));
      transaction.onabort = () => reject(transaction.error || new Error("Việc lưu dữ liệu sách đã bị hủy."));
    });
  }

  async function saveBookRecord(record) {
    const database = await openStorage();
    const transaction = database.transaction(["books", "settings"], "readwrite");
    const complete = transactionComplete(transaction);
    transaction.objectStore("books").put(record);
    transaction.objectStore("settings").put({ key: "lastBookId", value: record.id });
    await complete;
  }

  async function getStoredBook(id) {
    const database = await openStorage();
    const transaction = database.transaction("books", "readonly");
    return requestResult(transaction.objectStore("books").get(id));
  }

  async function getStoredBooks() {
    const database = await openStorage();
    const transaction = database.transaction("books", "readonly");
    return requestResult(transaction.objectStore("books").getAll());
  }

  async function getReaderPreferences() {
    const database = await openStorage();
    const transaction = database.transaction("settings", "readonly");
    const setting = await requestResult(transaction.objectStore("settings").get("readerPreferences"));
    return setting?.value || null;
  }

  async function getSetting(key) {
    const database = await openStorage();
    const transaction = database.transaction("settings", "readonly");
    const setting = await requestResult(transaction.objectStore("settings").get(key));
    return setting?.value;
  }

  async function saveSetting(key, value) {
    const database = await openStorage();
    const transaction = database.transaction("settings", "readwrite");
    const complete = transactionComplete(transaction);
    transaction.objectStore("settings").put({ key, value });
    await complete;
  }

  async function saveReaderPreferences() {
    const database = await openStorage();
    const transaction = database.transaction("settings", "readwrite");
    const complete = transactionComplete(transaction);
    transaction.objectStore("settings").put({ key: "readerPreferences", value: readerPreferences });
    await complete;
  }

  function setReaderSettingsStatus(message, isError = false) {
    const status = $("#reader-settings-status");
    status.textContent = message;
    status.classList.toggle("is-error", isError);
  }

  function syncReaderSettingsControls() {
    $("#sidebar").style.setProperty("--reader-font-scale", String(readerPreferences.fontSize / 100));
    $("#reader-font").value = readerPreferences.fontFamily;
    $("#reader-font-size").value = String(readerPreferences.fontSize);
    $("#reader-font-size-value").textContent = `${readerPreferences.fontSize}%`;
    $("#reader-line-height").value = String(readerPreferences.lineHeight);
    $("#reader-line-height-value").textContent = readerPreferences.lineHeight.toFixed(2).replace(/0$/, "");
    $("#reader-margin").value = String(readerPreferences.margin);
    $("#reader-margin-value").textContent = `${readerPreferences.margin} px`;
    const brightness = readerPreferences.brightness;
    $("#reader-brightness-auto").checked = brightness === null;
    $("#reader-brightness").disabled = brightness === null;
    if (brightness !== null) $("#reader-brightness").value = String(Math.round(brightness * 100));
    $("#reader-brightness-value").textContent = brightness === null ? "Theo máy" : `${Math.round(brightness * 100)}%`;
    $("#reader-text-color").value = readerPreferences.textColor;
    $("#reader-background-color").value = readerPreferences.backgroundColor;
  }

  function applyReaderPreferences() {
    fontSize = readerPreferences.fontSize;
    viewer.style.backgroundColor = readerPreferences.backgroundColor;
    document.documentElement.style.setProperty("--reader-bg", readerPreferences.backgroundColor);
    if (!rendition) return;

    const fontFamily = readerFontFamilies[readerPreferences.fontFamily];
    const { lineHeight, margin } = readerPreferences;
    rendition.themes.default({
      html: { background: `${readerPreferences.backgroundColor} !important` },
      body: {
        color: `${readerPreferences.textColor} !important`,
        background: `${readerPreferences.backgroundColor} !important`,
        "font-family": `${fontFamily} !important`,
        "font-size": `${fontSize}% !important`,
        "line-height": `${lineHeight} !important`,
        // epub.js tự chèn lề 1/12 bề rộng ở chế độ cuộn; !important để dùng lề người dùng chọn.
        padding: `12px ${margin}px !important`,
      },
      "body *": {
        color: `${readerPreferences.textColor} !important`,
        "font-family": `${fontFamily} !important`,
      },
      "h1, h2, h3": { "line-height": "1.4 !important" },
      "p, li, div, blockquote": { "line-height": `${lineHeight} !important` },
      p: { "text-align": "justify" },
    });
    rendition.themes.fontSize(`${fontSize}%`);
  }

  // Ở chế độ lật trang, lề hai bên là một nửa khoảng cách cột (gap) của epub.js.
  function applyReaderMargin() {
    if (!rendition) return;
    const gap = readerPreferences.margin * 2;
    rendition.settings.gap = gap;
    if (rendition.manager) {
      rendition.manager.settings.gap = gap;
      rendition.manager.updateLayout?.();
    }
    if (rendition.location) rendition.flow(readingMode);
  }

  function applyBrightness() {
    if (!nativeSpeech) return;
    const value = readerPreferences.brightness;
    nativeSpeech.setBrightness({ value: value === null ? -1 : value }).catch((error) => {
      console.warn("Không thể chỉnh độ sáng:", error);
    });
  }

  function applyTheme() {
    const theme = readerPreferences.theme;
    document.body.classList.toggle("theme-sepia", theme === "sepia");
    document.body.classList.toggle("theme-dark", theme === "dark");
    const next = readerThemes[readerThemeOrder[(readerThemeOrder.indexOf(theme) + 1) % readerThemeOrder.length]];
    // Màu thanh trạng thái / thanh địa chỉ theo giao diện.
    const chromeColors = { light: "#f6f4ee", sepia: "#f1e8d7", dark: "#252922" };
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", chromeColors[theme]);
    const button = $("#theme-toggle");
    button.title = `Giao diện: ${readerThemes[theme].label} (bấm để chuyển sang ${next.label})`;
    button.setAttribute("aria-label", button.title);
  }

  function updateReaderPreference(key, value) {
    readerPreferences = { ...readerPreferences, [key]: value };
    syncReaderSettingsControls();
    applyReaderPreferences();
    setReaderSettingsStatus("Đang lưu...");
  }

  async function persistReaderPreferences() {
    try {
      await saveReaderPreferences();
      setReaderSettingsStatus("Đã lưu tùy chỉnh trên thiết bị");
    } catch (error) {
      console.error("Không thể lưu tùy chỉnh hiển thị:", error);
      setReaderSettingsStatus("Không thể lưu tùy chỉnh trên thiết bị", true);
    }
  }

  async function saveCurrentPosition(cfi, bookId = currentBookId) {
    if (!bookId || !cfi) return;
    const record = await getStoredBook(bookId);
    if (!record) return;
    record.cfi = cfi;
    record.updatedAt = Date.now();
    await saveBookRecord(record);
  }

  function setSaveStatus(message, isError = false) {
    const status = $("#book-save-status");
    status.textContent = message;
    status.classList.toggle("is-error", isError);
  }

  function setLibraryStatus(message, isError = false) {
    const status = $("#library-status");
    status.textContent = message;
    status.hidden = !message;
    status.classList.toggle("is-error", isError);
  }

  async function renderLibrary() {
    const books = await getStoredBooks();
    books.sort((first, second) => (second.updatedAt || 0) - (first.updatedAt || 0));
    const bookList = $("#library-books");
    bookList.replaceChildren();
    $("#library-empty").hidden = books.length > 0;
    books.forEach((record, index) => {
      const card = document.createElement("article");
      card.className = "library-book";
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      const titleText = record.title || stripBookExtension(record.name);
      card.setAttribute("aria-label", `Mở tiếp sách ${titleText}`);
      const openSavedBook = () => openBook(null, record);
      card.addEventListener("click", openSavedBook);
      card.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openSavedBook();
      });
      const cover = document.createElement("div");
      cover.className = `library-book-cover palette-${index % 4}`;
      cover.setAttribute("aria-hidden", "true");
      const ornament = document.createElement("span");
      ornament.className = "library-cover-ornament";
      const coverTitle = document.createElement("span");
      coverTitle.className = "library-cover-title";
      coverTitle.textContent = titleText;
      const coverAuthor = document.createElement("span");
      coverAuthor.className = "library-cover-author";
      coverAuthor.textContent = record.author || "MỘT CUỐN SÁCH";
      cover.append(ornament, coverTitle, coverAuthor);
      const title = document.createElement("h2");
      title.textContent = titleText;
      const details = document.createElement("p");
      details.textContent = record.author || "Đã lưu trên thiết bị";
      const copy = document.createElement("div");
      copy.className = "library-book-copy";
      const saved = document.createElement("span");
      saved.className = "library-book-saved";
      saved.textContent = record.cfi ? "Đã lưu vị trí đọc" : "Sẵn sàng để đọc";
      copy.append(title, details, saved);
      card.append(cover, copy);
      bookList.append(card);
    });
    setLibraryStatus("");
  }

  function showReaderView() {
    document.body.classList.add("is-reading");
    document.body.classList.add("is-immersive");
    hideReaderChrome();
    if (isCompactReader()) setAudioPanelOpen(false);
    $("#home-screen").hidden = true;
    $("#app-shell").hidden = false;
    $("#home-button").hidden = false;
  }

  async function showHomeView() {
    stopSpeech();
    window.clearTimeout(readerChromeTimer);
    document.body.classList.remove("is-immersive", "reader-chrome-visible");
    $("#app-shell").classList.remove("audio-panel-hidden");
    if (document.fullscreenElement && document.exitFullscreen) {
      try {
        await document.exitFullscreen();
      } catch (error) {
        console.warn("Không thể thoát chế độ toàn màn hình:", error);
      }
    }
    if (currentBookId && rendition) {
      try {
        window.clearTimeout(savePositionTimer);
        const cfi = rendition.currentLocation()?.start?.cfi;
        if (cfi) await saveCurrentPosition(cfi);
      } catch (error) {
        console.error("Không thể lưu vị trí đọc:", error);
        setSaveStatus("Không lưu được vị trí đọc trên thiết bị", true);
      }
    }
    document.body.classList.remove("is-reading");
    $("#app-shell").hidden = true;
    $("#home-screen").hidden = false;
    $("#home-button").hidden = true;
    try {
      await renderLibrary();
    } catch (error) {
      console.error("Không thể tải thư viện sách:", error);
      setLibraryStatus("Không thể đọc thư viện sách trên thiết bị.", true);
    }
  }

  function updateReadingModeControl() {
    const isScrolling = readingMode === "scrolled-doc";
    const button = $("#reading-mode-toggle");
    button.setAttribute("aria-pressed", String(isScrolling));
    button.title = isScrolling ? "Chuyển sang chế độ lật trang" : "Chuyển sang cuộn dọc";
    button.setAttribute("aria-label", button.title);
    $("#reading-mode-label").textContent = isScrolling ? "Cuộn" : "Trang";
    $("#reader-column")?.classList.toggle("is-scrolling", isScrolling);
  }

  function isCompactReader() {
    return window.innerWidth <= 650;
  }

  // Trên điện thoại, bảng nghe sách là bottom sheet nổi trên trang nên nút mở luôn hiện để bật/tắt.
  function setAudioPanelOpen(open) {
    $("#app-shell").classList.toggle("audio-panel-hidden", !open);
    $("#hide-audio-panel").setAttribute("aria-expanded", String(open));
    const showButton = $("#show-audio-panel");
    showButton.hidden = open && !isCompactReader();
    showButton.setAttribute("aria-expanded", String(open));
    showButton.title = open ? "Ẩn bảng nghe sách" : "Hiện bảng nghe sách";
    showButton.setAttribute("aria-label", showButton.title);
    if (!isCompactReader()) resizeRenditionToViewer();
  }

  function hideReaderChrome() {
    window.clearTimeout(readerChromeTimer);
    document.body.classList.remove("reader-chrome-visible");
  }

  function showReaderChrome() {
    if (!document.body.classList.contains("is-immersive")) return;
    window.clearTimeout(readerChromeTimer);
    document.body.classList.add("reader-chrome-visible");
    readerChromeTimer = window.setTimeout(hideReaderChrome, 4000);
  }

  function toggleReaderChrome() {
    if (document.body.classList.contains("reader-chrome-visible")) hideReaderChrome();
    else showReaderChrome();
  }

  // Vị trí chạm theo tỉ lệ bề ngang vùng đọc (0 = mép trái, 1 = mép phải).
  function readerTapRatio(contentDocument, clientX) {
    const frame = contentDocument.defaultView?.frameElement;
    const viewerRect = viewer.getBoundingClientRect();
    if (!frame || !viewerRect.width) return 0.5;
    return (frame.getBoundingClientRect().left + clientX - viewerRect.left) / viewerRect.width;
  }

  // Chế độ lật trang: chạm mép trái/phải để lật, chạm giữa để bật/tắt thanh điều khiển.
  function handleReaderTap(contentDocument, clientX) {
    if (readingMode === "paginated" && rendition) {
      const ratio = readerTapRatio(contentDocument, clientX);
      if (ratio < 0.28 || ratio > 0.72) {
        hideReaderChrome();
        if (ratio < 0.28) rendition.prev();
        else rendition.next();
        return;
      }
    }
    toggleReaderChrome();
  }

  function bindReaderGestures(contentDocument) {
    if (!contentDocument || readerGestureDocuments.has(contentDocument)) return;
    readerGestureDocuments.add(contentDocument);
    let touchStart = null;
    let lastTouchEndAt = 0;
    let lastTouchLink = "";
    let lastTouchLinkAt = 0;
    const handleReaderLink = (event, isTouch = false) => {
      const eventTarget = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
      const link = eventTarget?.closest?.("a[href]");
      const href = link?.getAttribute("href")?.trim();
      if (!href || /^([a-z][a-z\d+.-]*:|\/\/)/i.test(href)) return false;

      event.preventDefault();
      event.stopPropagation();
      if (!rendition) return true;
      if (!isTouch && href === lastTouchLink && Date.now() - lastTouchLinkAt < 800) return true;
      if (isTouch) {
        lastTouchLink = href;
        lastTouchLinkAt = Date.now();
      }
      const target = new URL(href, contentDocument.baseURI);
      const targetHref = `${book.path.relative(decodeURI(target.pathname))}${target.hash}`;
      stopSpeech();
      showReaderChrome();
      rendition.display(targetHref).catch((error) => {
        console.error("Không thể mở liên kết trong sách:", error);
        setError("Không thể mở chương được chọn trong sách này.");
      });
      return true;
    };
    contentDocument.addEventListener("click", (event) => {
      if (handleReaderLink(event)) return;
      // Chạm trên màn hình cảm ứng đã được xử lý ở touchend.
      if (Date.now() - lastTouchEndAt < 800) return;
      handleReaderTap(contentDocument, event.clientX);
    }, { capture: true });
    contentDocument.addEventListener("touchstart", (event) => {
      const touch = event.changedTouches[0];
      if (touch) touchStart = { x: touch.clientX, y: touch.clientY, time: Date.now(), moved: false };
    }, { capture: true, passive: true });
    contentDocument.addEventListener("touchmove", (event) => {
      const touch = event.changedTouches[0];
      if (!touch || !touchStart || touchStart.moved) return;
      if (Math.hypot(touch.clientX - touchStart.x, touch.clientY - touchStart.y) > 12) {
        touchStart.moved = true;
        hideReaderChrome();
      }
    }, { capture: true, passive: true });
    contentDocument.addEventListener("touchend", (event) => {
      if (!touchStart) return;
      const touch = event.changedTouches[0];
      if (!touch) return;
      const dx = touch.clientX - touchStart.x;
      const dy = touch.clientY - touchStart.y;
      const duration = Date.now() - touchStart.time;
      touchStart = null;
      lastTouchEndAt = Date.now();
      // Vuốt ngang ở chế độ lật trang: trái sang trang sau, phải về trang trước.
      if (readingMode === "paginated" && rendition && Math.abs(dx) > 30
        && Math.abs(dx) > Math.abs(dy) * 1.2 && duration < 1000) {
        hideReaderChrome();
        if (dx < 0) rendition.next();
        else rendition.prev();
        return;
      }
      // Kéo hoặc nhấn giữ (chọn chữ) thì không coi là chạm.
      if (Math.hypot(dx, dy) > 10 || duration > 600) return;
      if (handleReaderLink(event, true)) return;
      if (event.cancelable) event.preventDefault();
      handleReaderTap(contentDocument, touch.clientX);
    }, { capture: true, passive: false });
    contentDocument.addEventListener("touchcancel", () => {
      touchStart = null;
      hideReaderChrome();
    }, { capture: true, passive: true });
    contentDocument.addEventListener("scroll", hideReaderChrome, { capture: true, passive: true });
  }

  function resizeRenditionToViewer() {
    if (!rendition) return;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const { width, height } = viewer.getBoundingClientRect();
        if (width > 0 && height > 0) rendition.resize(width, height);
      });
    });
  }

  function setError(message) {
    readerError.textContent = message;
    readerError.hidden = false;
    loadingState.hidden = true;
  }

  function setFullscreenHint(message) {
    const hint = $("#fullscreen-hint");
    hint.textContent = message;
    hint.hidden = false;
    window.setTimeout(() => {
      if (hint.textContent === message) hint.hidden = true;
    }, 7000);
  }

  async function enterReadingFullscreen() {
    if (window.innerWidth > 650 || document.fullscreenElement || window.matchMedia("(display-mode: standalone)").matches || navigator.standalone) return;
    if (!document.documentElement.requestFullscreen) {
      setFullscreenHint("Để ẩn thanh địa chỉ, hãy thêm Sách của bạn vào Màn hình chính rồi mở bằng biểu tượng ứng dụng.");
      return;
    }
    try {
      await document.documentElement.requestFullscreen();
    } catch (error) {
      console.warn("Trình duyệt không cho phép bật toàn màn hình:", error);
      setFullscreenHint("Trình duyệt chưa cho phép ẩn thanh địa chỉ. Hãy thêm Sách của bạn vào Màn hình chính để mở như ứng dụng.");
    }
  }

  function setSpeechStatus(message, active = false) {
    $("#speech-status-text").textContent = message;
    speechStatus.classList.toggle("is-active", active);
    audioIllustration.classList.toggle("is-speaking", active);
  }

  // Giọng trên máy (như Linh) dừng khi iOS khóa màn hình, nên giữ màn hình sáng trong lúc đọc.
  let wakeLock = null;
  let wakeLockWanted = false;

  async function syncWakeLock() {
    if (!("wakeLock" in navigator)) return;
    try {
      if (wakeLockWanted && !wakeLock && document.visibilityState === "visible") {
        const lock = await navigator.wakeLock.request("screen");
        if (!wakeLockWanted) {
          await lock.release();
          return;
        }
        wakeLock = lock;
        lock.addEventListener("release", () => {
          if (wakeLock === lock) wakeLock = null;
        });
      } else if (!wakeLockWanted && wakeLock) {
        const lock = wakeLock;
        wakeLock = null;
        await lock.release();
      }
    } catch (error) {
      console.warn("Không thể giữ màn hình sáng:", error);
    }
  }

  function setKeepScreenOn(on) {
    if (wakeLockWanted === on) return;
    wakeLockWanted = on;
    syncWakeLock();
  }

  // Chương đang được đọc; có thể khác trang đang hiển thị khi máy khóa màn hình.
  let speechSpineIndex = null;

  function adjacentChapterSection(offset) {
    const listening = playButton.classList.contains("is-playing") && speechSpineIndex !== null;
    const index = listening
      ? speechSpineIndex
      : rendition?.currentLocation()?.start?.index ?? currentSpineIndex;
    const section = index !== null && index !== undefined ? book?.spine.get(index) : null;
    if (!section) return null;
    return (offset > 0 ? section.next() : section.prev()) || null;
  }

  async function goToAdjacentChapter(offset, keepListening = isSpeechActive()) {
    if (!rendition) return;
    if (isNativeSpeaking()) {
      (offset > 0 ? nativeSpeech.next() : nativeSpeech.previous()).catch((error) => {
        console.error("Không thể chuyển chương:", error);
      });
      return;
    }
    const section = adjacentChapterSection(offset);
    if (!section) {
      if (!keepListening) stopSpeech();
      setSpeechStatus(offset > 0 ? "Đã hết sách" : "Đây là chương đầu tiên");
      return;
    }
    if (!keepListening) {
      stopSpeech();
      rendition.display(section.href).catch((error) => {
        console.error("Không thể chuyển chương:", error);
        setSpeechStatus("Không thể chuyển chương");
      });
      return;
    }

    // Khi màn hình khóa, iOS không cho phát lại audio đã bị gỡ và không vẽ trang mới,
    // nên giữ nguyên trình phát, đọc nội dung chương thẳng từ EPUB rồi phát tiếp ngay.
    audioPlayer.onended = null;
    audioPlayer.onerror = null;
    if (synth && (synth.speaking || synth.pending)) {
      synth.cancel();
      lastSynthCancelAt = Date.now();
    }
    currentUtterance = null;
    speechQueue = [];
    isPaused = false;
    setSpeechStatus(offset > 0 ? "Đang chuyển sang chương sau..." : "Đang chuyển về chương trước...", true);
    try {
      // Bỏ qua các mục không có chữ (trang bìa, trang chỉ có ảnh...) để đọc liền mạch.
      let target = section;
      let text = "";
      for (let tries = 0; target && tries < 10; tries += 1) {
        speechSpineIndex = target.index;
        text = await loadSectionText(target);
        if (speechSpineIndex !== target.index) return;
        if (text) break;
        target = offset > 0 ? target.next() : target.prev();
      }
      if (!target || !text) {
        stopSpeech();
        setSpeechStatus(offset > 0 ? "Đã hết sách" : "Đây là chương đầu tiên");
        return;
      }
      setChapterLabel(tocLabelsBySpineIndex.get(target.index) || `Chương ${target.index + 1}`);
      rendition.display(target.href).catch((error) => {
        console.error("Không thể hiển thị chương mới:", error);
      });
      prepareSpeech(text);
    } catch (error) {
      console.error("Không thể chuyển chương:", error);
      stopSpeech();
      setSpeechStatus("Không thể chuyển chương");
    }
  }

  function isSpeechActive() {
    return playButton.classList.contains("is-playing") && !isPaused;
  }

  function updateMediaSession(isPlaying) {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState = isPlaying ? (isPaused ? "paused" : "playing") : "none";
    if (!isPlaying) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentChapter,
        artist: $("#book-title").textContent,
        album: "Sách của bạn",
      });
    } catch (error) {
      console.warn("Không thể cập nhật thông tin phát trên màn hình khóa:", error);
    }
  }

  function updateSpeechButtons(isPlaying = false) {
    updateMediaSession(isPlaying);
    setKeepScreenOn(isPlaying && !isPaused && !usingOnlineVoice && !nativeSpeech);
    playButton.classList.toggle("is-playing", isPlaying);
    $("#play-label").textContent = isPlaying ? (isPaused ? "Tiếp tục nghe" : "Đang đọc") : "Nghe chương này";
  }

  function enableReading(enabled) {
    $("#prev-page").disabled = !enabled;
    $("#next-page").disabled = !enabled;
    playButton.disabled = !enabled;
    $("#prev-chapter").disabled = !enabled;
    $("#next-chapter").disabled = !enabled;
    stopButton.disabled = !enabled;
    $("#audio-hint").textContent = enabled ? "Đọc nội dung chương hiện tại" : "Mở sách để bắt đầu";
  }

  function setChapterLabel(label) {
    currentChapter = label || "Đang đọc";
    $("#chapter-label").textContent = currentChapter;
    $("#audio-hint").textContent = currentChapter;
    for (const button of tocList.querySelectorAll("button")) {
      button.classList.toggle("active", button.dataset.label === currentChapter);
    }
  }

  function populateToc(items, depth = 0) {
    for (const item of items) {
      const section = book.spine.get(item.href?.split("#")[0]);
      if (section?.index !== undefined) tocLabelsBySpineIndex.set(section.index, item.label || "Chương");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = item.label || "Chương";
      button.title = item.label || "Chương";
      button.dataset.href = item.href;
      button.dataset.label = item.label || "Chương";
      button.style.paddingLeft = `${10 + Math.min(depth, 3) * 12}px`;
      button.addEventListener("click", () => {
        stopSpeech();
        const targetSection = book.spine.get(item.href?.split("#")[0]);
        currentSpineIndex = targetSection?.index ?? null;
        setChapterLabel(item.label);
        rendition.display(item.href).catch((error) => {
          console.error("Không thể mở chương từ mục lục:", error);
          setError("Không thể mở chương được chọn từ mục lục.");
        });
        if (window.innerWidth <= 650) $("#sidebar").classList.remove("is-open");
      });
      tocList.append(button);
      if (item.subitems?.length) populateToc(item.subitems, depth + 1);
    }
  }

  function goToChapter(number) {
    const chapters = tocList.querySelectorAll("button");
    const button = chapters[number - 1];
    if (!button) return false;
    button.click();
    return true;
  }

  function readableTextFromDocument(doc) {
    if (!doc.body) return "";
    const body = doc.body.cloneNode(true);
    const ignored = "script, style, nav, [aria-hidden='true'], svg";
    for (const node of body.querySelectorAll(ignored)) node.remove();
    // Bản sao không được hiển thị nên innerText không tự ngắt dòng: chèn khoảng trắng
    // sau mỗi khối để tiêu đề và đoạn văn không bị dính chữ khi đọc.
    const blocks = "p, div, h1, h2, h3, h4, h5, h6, li, dt, dd, blockquote, section, article, tr, td, th, figcaption, br";
    for (const node of body.querySelectorAll(blocks)) node.after(doc.createTextNode(" "));
    return (body.innerText || body.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getRenderedChapterText() {
    return [...viewer.querySelectorAll("iframe")]
      .map((frame) => frame.contentDocument)
      .filter(Boolean)
      .map(readableTextFromDocument)
      .filter(Boolean)
      .join(" ")
      .trim();
  }

  // section.load() của epub.js trả về phần tử <html>, không phải document.
  async function loadSectionText(section) {
    const root = await section.load(book.load.bind(book));
    return readableTextFromDocument(root?.ownerDocument || root);
  }

  async function getChapterText() {
    const renderedText = getRenderedChapterText();
    if (renderedText) return renderedText;

    const location = rendition?.currentLocation();
    const section = location?.start?.index !== undefined
      ? book.spine.get(location.start.index)
      : null;
    if (!section) throw new Error("Không xác định được nội dung chương này.");

    try {
      return await loadSectionText(section);
    } finally {
      section.unload();
    }
  }

  function splitIntoChunks(text, maxLength = 220) {
    const sentences = text.match(/[^.!?。！？]+[.!?。！？]*/g) || [text];
    const chunks = [];
    let chunk = "";
    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (!trimmed) continue;
      if (chunk && `${chunk} ${trimmed}`.length > maxLength) {
        chunks.push(chunk);
        chunk = "";
      }
      if (trimmed.length > maxLength) {
        if (chunk) chunks.push(chunk);
        chunk = "";
        for (let start = 0; start < trimmed.length; start += maxLength) {
          chunks.push(trimmed.slice(start, start + maxLength));
        }
      } else {
        chunk = chunk ? `${chunk} ${trimmed}` : trimmed;
      }
    }
    if (chunk) chunks.push(chunk);
    return chunks;
  }

  // Safari/iOS nuốt mất lượt đọc nếu speak() được gọi ngay sau cancel().
  let lastSynthCancelAt = 0;
  let synthUnlocked = false;

  function isNativeSpeaking() {
    return Boolean(nativeSpeech) && (nativeState === "playing" || nativeState === "paused");
  }

  async function nativeChapterPayload(section) {
    const text = await loadSectionText(section);
    // Giải phóng bộ nhớ của các chương không đang hiển thị.
    if (section.index !== rendition?.currentLocation()?.start?.index) section.unload();
    return {
      index: section.index,
      title: tocLabelsBySpineIndex.get(section.index) || `Chương ${section.index + 1}`,
      text,
    };
  }

  async function startNativeSpeech() {
    if (nativeState === "playing") {
      nativeSpeech.pause();
      return;
    }
    if (nativeState === "paused") {
      nativeSpeech.resume();
      return;
    }
    stopSpeech();
    const token = ++nativeLoadToken;
    const startIndex = rendition?.currentLocation()?.start?.index ?? currentSpineIndex ?? 0;
    const startSection = book.spine.get(startIndex);
    if (!startSection) {
      setSpeechStatus("Không xác định được chương hiện tại");
      return;
    }
    setSpeechStatus("Đang chuẩn bị giọng đọc...", true);
    try {
      const first = await nativeChapterPayload(startSection);
      if (token !== nativeLoadToken) return;
      await nativeSpeech.start({
        chapters: [first],
        startChapter: 0,
        voiceId: voiceSelect.value,
        rate: Number($("#rate-range").value),
        volume: Number($("#volume-range").value),
        bookTitle: $("#book-title").textContent,
      });
      nativeState = "playing";
      // Gửi trước các chương còn lại để native tự đọc tiếp khi app chạy nền.
      let batch = [];
      for (let section = startSection.next(); section; section = section.next()) {
        batch.push(await nativeChapterPayload(section));
        if (token !== nativeLoadToken) return;
        if (batch.length >= 5) {
          await nativeSpeech.appendChapters({ chapters: batch });
          batch = [];
        }
      }
      if (batch.length) await nativeSpeech.appendChapters({ chapters: batch });
      const before = [];
      for (let section = startSection.prev(); section; section = section.prev()) {
        before.unshift(await nativeChapterPayload(section));
        if (token !== nativeLoadToken) return;
      }
      if (before.length) await nativeSpeech.prependChapters({ chapters: before });
    } catch (error) {
      console.error("Không thể phát giọng đọc native:", error);
      if (token === nativeLoadToken && nativeState !== "playing") setSpeechStatus("Không thể phát giọng đọc này");
    }
  }

  function handleNativeState(state) {
    if ((state === "stopped" || state === "finished") && nativeState === "stopped") return;
    nativeState = state;
    if (state === "playing") {
      isPaused = false;
      updateSpeechButtons(true);
      setSpeechStatus("Đang đọc chương này", true);
    } else if (state === "paused") {
      isPaused = true;
      updateSpeechButtons(true);
      setSpeechStatus("Đang tạm dừng");
      audioIllustration.classList.remove("is-speaking");
    } else {
      nativeState = "stopped";
      nativeLoadToken += 1;
      isPaused = false;
      updateSpeechButtons(false);
      setSpeechStatus(state === "finished" ? "Đã đọc xong cuốn sách" : "Sẵn sàng khi bạn cần");
    }
  }

  function handleNativeChapter(index, title) {
    speechSpineIndex = index;
    setChapterLabel(title || `Chương ${index + 1}`);
    const section = book?.spine.get(index);
    if (rendition && section && rendition.currentLocation()?.start?.index !== index) {
      rendition.display(section.href).catch((error) => {
        console.error("Không thể hiển thị chương đang đọc:", error);
      });
    }
  }

  function stopSpeech() {
    if (isNativeSpeaking()) {
      nativeState = "stopped";
      nativeLoadToken += 1;
      nativeSpeech.stop().catch(() => {});
    }
    if (synth && (synth.speaking || synth.pending)) {
      synth.cancel();
      lastSynthCancelAt = Date.now();
    }
    audioPlayer.pause();
    audioPlayer.removeAttribute("src");
    audioPlayer.load();
    speechQueue = [];
    speechIndex = 0;
    currentUtterance = null;
    usingOnlineVoice = false;
    isPaused = false;
    updateSpeechButtons(false);
    setSpeechStatus("Sẵn sàng khi bạn cần");
  }

  function speakNextChunk() {
    if (speechIndex >= speechQueue.length) {
      speechQueue = [];
      currentUtterance = null;
      isPaused = false;
      if (adjacentChapterSection(1)) {
        goToAdjacentChapter(1, true);
        return;
      }
      updateSpeechButtons(false);
      setSpeechStatus("Đã đọc xong cuốn sách");
      return;
    }

    if (usingOnlineVoice) {
      const text = speechQueue[speechIndex];
      const audioUrl = new URL("https://translate.google.com/translate_tts");
      audioUrl.searchParams.set("ie", "UTF-8");
      audioUrl.searchParams.set("client", "tw-ob");
      audioUrl.searchParams.set("tl", "vi");
      audioUrl.searchParams.set("q", text);
      audioPlayer.src = audioUrl.toString();
      audioPlayer.playbackRate = Number($("#rate-range").value);
      audioPlayer.onended = () => {
        speechIndex += 1;
        speakNextChunk();
      };
      audioPlayer.onerror = () => {
        const mediaErrorCode = audioPlayer.error?.code;
        stopSpeech();
        if (mediaErrorCode === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
          setSpeechStatus("Dịch vụ giọng tiếng Việt không trả về âm thanh. Hãy thử lại hoặc chọn giọng có sẵn.");
        } else {
          setSpeechStatus("Không phát được giọng trực tuyến. Hãy kiểm tra kết nối mạng rồi thử lại.");
        }
      };
      audioPlayer.play().then(() => {
        // Mỗi đoạn audio mới có thể làm iOS xóa thông tin và nút trên màn hình khóa.
        registerMediaSessionHandlers();
        updateMediaSession(true);
      }).catch((error) => {
        stopSpeech();
        if (error.name === "NotAllowedError") {
          setSpeechStatus("Trình duyệt chặn phát tự động. Hãy nhấn Nghe chương này để cấp quyền phát.");
        } else {
          setSpeechStatus("Không thể phát giọng trực tuyến. Hãy kiểm tra kết nối hoặc thử giọng đọc khác.");
          console.error("Không phát được âm thanh đọc sách:", error);
        }
      });
      return;
    }

    if (!synth) {
      stopSpeech();
      setSpeechStatus("Trình duyệt không hỗ trợ giọng đọc trên máy");
      return;
    }
    const sinceCancel = Date.now() - lastSynthCancelAt;
    if (sinceCancel < 250) {
      const queue = speechQueue;
      window.setTimeout(() => {
        if (speechQueue === queue) speakNextChunk();
      }, 250 - sinceCancel);
      return;
    }
    const utterance = new SpeechSynthesisUtterance(speechQueue[speechIndex]);
    const selectedVoice = voiceSelect.value;
    utterance.voice = voices.find((voice) => voice.voiceURI === selectedVoice) || null;
    utterance.lang = utterance.voice?.lang || "vi-VN";
    utterance.rate = Number($("#rate-range").value);
    utterance.volume = Number($("#volume-range").value);
    utterance.onend = () => {
      if (currentUtterance !== utterance) return;
      speechIndex += 1;
      speakNextChunk();
    };
    utterance.onerror = (event) => {
      if (event.error === "canceled" || event.error === "interrupted") return;
      stopSpeech();
      setSpeechStatus("Không thể phát giọng đọc này");
    };
    let started = false;
    utterance.onstart = () => {
      started = true;
    };
    currentUtterance = utterance;
    synth.speak(utterance);
    window.setTimeout(() => {
      if (!started && currentUtterance === utterance && !isPaused) {
        setSpeechStatus("Chưa nghe thấy tiếng? Hãy tắt chế độ im lặng của máy hoặc chọn giọng Google.", true);
      }
    }, 4000);
  }

  function prepareSpeech(text) {
    if (!text) {
      setSpeechStatus("Chương này chưa có nội dung văn bản");
      return;
    }
    usingOnlineVoice = voiceSelect.value === "online-vi";
    speechQueue = splitIntoChunks(text, usingOnlineVoice ? 180 : 220);
    speechIndex = 0;
    isPaused = false;
    updateSpeechButtons(true);
    setSpeechStatus(
      usingOnlineVoice ? "Đang đọc bằng giọng tiếng Việt trực tuyến" : "Đang đọc chương này",
      true,
    );
    speakNextChunk();
  }

  function startSpeech() {
    if (!book) {
      setSpeechStatus("Hãy mở sách để bắt đầu nghe");
      return;
    }
    if (nativeSpeech && voiceSelect.value !== "online-vi") {
      startNativeSpeech();
      return;
    }
    if (isPaused && usingOnlineVoice) {
      audioPlayer.play().catch(() => setSpeechStatus("Không thể tiếp tục phát âm thanh"));
      isPaused = false;
      updateSpeechButtons(true);
      setSpeechStatus("Đang đọc chương này", true);
      return;
    }
    if (synth && synth.paused && isPaused) {
      synth.resume();
      isPaused = false;
      updateSpeechButtons(true);
      setSpeechStatus("Đang đọc chương này", true);
      return;
    }
    if (usingOnlineVoice && audioPlayer.src && !isPaused) {
      audioPlayer.pause();
      isPaused = true;
      updateSpeechButtons(true);
      setSpeechStatus("Đang tạm dừng");
      audioIllustration.classList.remove("is-speaking");
      return;
    }
    if (synth && synth.speaking && !isPaused) {
      synth.pause();
      isPaused = true;
      updateSpeechButtons(true);
      setSpeechStatus("Đang tạm dừng");
      audioIllustration.classList.remove("is-speaking");
      return;
    }

    stopSpeech();
    // Safari 17+: xin phiên âm thanh "playback" để vẫn phát khi máy gạt im lặng (nếu được hỗ trợ).
    try {
      if (navigator.audioSession) navigator.audioSession.type = "playback";
    } catch (error) {
      console.warn("Không thể đổi phiên âm thanh:", error);
    }
    // iOS chỉ cho phát giọng trên máy nếu lần đọc đầu tiên bắt đầu ngay trong lượt chạm.
    if (synth && !synthUnlocked && voiceSelect.value !== "online-vi") {
      const unlock = new SpeechSynthesisUtterance(" ");
      unlock.volume = 0;
      unlock.lang = "vi-VN";
      synth.speak(unlock);
      synthUnlocked = true;
    }
    speechSpineIndex = rendition?.currentLocation()?.start?.index ?? currentSpineIndex;
    const renderedText = getRenderedChapterText();
    if (renderedText) {
      prepareSpeech(renderedText);
      return;
    }

    setSpeechStatus("Đang chuẩn bị giọng đọc...");
    getChapterText().then(
      prepareSpeech,
      (error) => setSpeechStatus(error.message || "Không thể tải nội dung chương"),
    );
  }

  function updateProgress(location) {
    if (!location?.start) return;
    const percentage = location.start.percentage || 0;
    currentProgress = Math.min(100, Math.max(0, Math.round(percentage * 100)));
    $("#progress-fill").style.width = `${currentProgress}%`;
    $("#progress-label").textContent = `${currentProgress}% đã đọc`;
    const spineIndex = location.start.index;
    const section = book?.spine.get(spineIndex);
    if (spineIndex !== currentSpineIndex) {
      currentSpineIndex = spineIndex;
      const tocLabel = tocLabelsBySpineIndex.get(spineIndex);
      setChapterLabel(tocLabel || `Chương ${spineIndex + 1}`);
    }
    if (location.start.cfi && currentBookId) {
      window.clearTimeout(savePositionTimer);
      const bookId = currentBookId;
      savePositionTimer = window.setTimeout(() => {
        saveCurrentPosition(location.start.cfi, bookId).then(
          () => setSaveStatus("Đã lưu sách và vị trí đọc trên thiết bị"),
          (error) => {
            console.error("Không thể lưu vị trí đọc:", error);
            setSaveStatus("Không lưu được vị trí đọc trên thiết bị", true);
          },
        );
      }, 350);
    }
  }

  function updateBookInfo(metadata, fileName) {
    const title = metadata.title?.trim() || stripBookExtension(fileName);
    const author = metadata.creator?.trim() || "Tác giả chưa rõ";
    $("#book-title").textContent = title;
    $("#book-author").textContent = author;
    $("#cover-title").textContent = title.length > 36 ? `${title.slice(0, 33)}…` : title;
    $("#cover-author").textContent = author.toLocaleUpperCase("vi").slice(0, 36);
    document.title = `${title} — Sách của bạn`;
  }

  function readFileAsArrayBuffer(file) {
    if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("Không đọc được tệp sách."));
      reader.readAsArrayBuffer(file);
    });
  }

  function stripBookExtension(name) {
    return window.BookConverters?.stripExtension(name) ?? String(name || "").replace(/\.epub$/i, "");
  }

  async function openBook(file, savedRecord = null) {
    if (!file && !savedRecord) return;
    const fileName = savedRecord?.name || file.name;
    if (!savedRecord && !window.BookConverters?.isSupported(fileName) && file?.type !== "application/epub+zip") {
      setError("Định dạng này chưa được hỗ trợ. Hãy chọn sách EPUB, MOBI, AZW3, PRC, TXT, FB2, DOCX hoặc HTML.");
      return;
    }
    if (typeof window.ePub !== "function") {
      setError("Không tải được thư viện đọc EPUB. Hãy kiểm tra kết nối mạng rồi tải lại trang.");
      return;
    }

    const fullscreenRequest = enterReadingFullscreen();
    stopSpeech();
    window.clearTimeout(savePositionTimer);
    if (currentBookId && rendition) {
      try {
        const currentCfi = rendition.currentLocation()?.start?.cfi;
        if (currentCfi) await saveCurrentPosition(currentCfi, currentBookId);
      } catch (error) {
        console.error("Không thể lưu vị trí trước khi mở sách khác:", error);
      }
    }
    await fullscreenRequest;
    if (rendition) rendition.destroy();
    if (book) book.destroy();
    book = null;
    rendition = null;
    currentFileName = fileName;
    currentBookId = savedRecord?.id || `${file.name}:${file.size}:${file.lastModified}`;
    currentSpineIndex = null;
    tocLabelsBySpineIndex.clear();
    readerError.hidden = true;
    loadingState.hidden = false;
    welcomeCard.hidden = true;
    viewer.classList.add("is-visible");
    viewer.replaceChildren();
    tocList.replaceChildren();
    $("#chapter-count").textContent = "";
    enableReading(false);
    showReaderView();

    let loadingStep = "đọc tệp sách";
    try {
      let bookData = savedRecord?.data;
      if (!bookData) {
        // Định dạng khác EPUB được chuyển thành EPUB một lần, rồi lưu bản EPUB vào thư viện.
        loadingStep = "chuyển đổi định dạng sách";
        $("#loading-state p").textContent = "Đang chuẩn bị sách...";
        bookData = window.BookConverters ? await window.BookConverters.toEpub(file) : await readFileAsArrayBuffer(file);
        $("#loading-state p").textContent = "Đang mở trang sách...";
      }
      const signature = new Uint8Array(bookData, 0, Math.min(4, bookData.byteLength));
      if (signature[0] !== 0x50 || signature[1] !== 0x4b) {
        throw new Error("Tệp được chọn không có cấu trúc EPUB/ZIP hợp lệ.");
      }

      loadingStep = "giải nén nội dung EPUB";
      book = window.ePub(bookData);
      await book.ready;
      // Chrome chặn listener trong iframe sandbox thiếu allow-scripts, nên phải bật script;
      // bù lại, loại bỏ mọi script/handler có sẵn trong nội dung EPUB.
      book.spine.hooks.content.register((doc) => {
        for (const node of doc.querySelectorAll("script")) node.remove();
        for (const el of doc.querySelectorAll("*")) {
          for (const attr of [...el.attributes]) {
            if (/^on/i.test(attr.name) || /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
          }
        }
      });
      loadingStep = "hiển thị nội dung sách";
      const readerSize = viewer.getBoundingClientRect();
      if (!readerSize.width || !readerSize.height) {
        throw new Error("Không xác định được kích thước vùng đọc.");
      }
      rendition = book.renderTo(viewer, {
        width: "100%",
        height: "100%",
        spread: "none",
        flow: readingMode,
        manager: "default",
        gap: readerPreferences.margin * 2,
        allowScriptedContent: true,
      });
      applyReaderPreferences();
      rendition.on("rendered", (_section, view) => {
        bindReaderGestures(view?.contents?.document || view?.iframe?.contentDocument);
      });
      rendition.on("relocated", updateProgress);
      await rendition.display(savedRecord?.cfi || undefined);

      const navigation = book.navigation?.toc || [];
      populateToc(navigation);
      const chapterButtons = tocList.querySelectorAll("button");
      $("#chapter-count").textContent = chapterButtons.length ? `${chapterButtons.length} chương` : "";
      const chapterInput = $("#toc-jump-input");
      chapterInput.max = String(chapterButtons.length);
      chapterInput.disabled = chapterButtons.length === 0;
      $("#toc-jump-form button").disabled = chapterButtons.length === 0;
      const displayedLocation = rendition.currentLocation();
      if (displayedLocation?.start) {
        currentSpineIndex = displayedLocation.start.index;
        setChapterLabel(
          tocLabelsBySpineIndex.get(currentSpineIndex) || `Chương ${currentSpineIndex + 1}`,
        );
      }
      const metadata = book.packaging?.metadata || {};
      updateBookInfo(metadata, currentFileName);
      enableReading(true);
      $("#prev-page").disabled = !savedRecord?.cfi;
      $("#next-page").disabled = false;
      loadingState.hidden = true;
      if (!savedRecord?.cfi) {
        $("#progress-fill").style.width = "0%";
        $("#progress-label").textContent = "0% đã đọc";
      }
      $("#audio-hint").textContent = currentChapter;
      if (!savedRecord) {
        try {
          await saveBookRecord({
            id: currentBookId,
            name: file.name,
            title: metadata.title?.trim() || stripBookExtension(file.name),
            author: metadata.creator?.trim() || "",
            size: file.size,
            lastModified: file.lastModified,
            data: bookData,
            cfi: rendition.currentLocation()?.start?.cfi || "",
            updatedAt: Date.now(),
          });
          setSaveStatus("Đã lưu sách và vị trí đọc trên thiết bị");
        } catch (error) {
          console.error("Không thể lưu sách trên thiết bị:", error);
          setSaveStatus("Sách đã mở nhưng không thể lưu trên thiết bị", true);
        }
      } else {
        try {
          await saveBookRecord({
            ...savedRecord,
            title: metadata.title?.trim() || savedRecord.title || stripBookExtension(fileName),
            author: metadata.creator?.trim() || savedRecord.author || "",
            cfi: rendition.currentLocation()?.start?.cfi || savedRecord.cfi,
            updatedAt: Date.now(),
          });
          setSaveStatus("Đã lưu sách và vị trí đọc trên thiết bị");
        } catch (error) {
          console.error("Không thể cập nhật thông tin sách đã lưu:", error);
          setSaveStatus("Sách đã mở nhưng không thể lưu thông tin cập nhật", true);
        }
      }
      try {
        await renderLibrary();
      } catch (error) {
        console.error("Không thể cập nhật thư viện sách:", error);
        setLibraryStatus("Sách đã mở nhưng không thể cập nhật thư viện.", true);
      }
    } catch (error) {
      console.error("Không thể mở tệp EPUB:", error);
      const details = error instanceof Error ? error.message : String(error);
      setError(`Không thể ${loadingStep}. ${details || "Tệp có thể bị lỗi hoặc được bảo vệ bằng DRM."}`);
      welcomeCard.hidden = false;
      viewer.classList.remove("is-visible");
      enableReading(false);
    }
  }

  // Chỉ hiện giọng tiếng Việt, giọng theo ngôn ngữ của máy và các ngôn ngữ người dùng tự thêm.
  const deviceLanguage = voiceLanguage(navigator.languages?.[0] || navigator.language || "vi");
  let extraVoiceLanguages = [];
  const languageNames = (() => {
    try {
      return new Intl.DisplayNames(["vi"], { type: "language" });
    } catch {
      return null;
    }
  })();

  function voiceLanguage(lang) {
    return String(lang || "").toLowerCase().split(/[-_]/)[0];
  }

  function languageName(code) {
    let name = code;
    try {
      name = languageNames?.of(code) || code;
    } catch {
      // Mã ngôn ngữ không hợp lệ: giữ nguyên mã.
    }
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  function shownVoiceLanguages() {
    return [...new Set(["vi", deviceLanguage, ...extraVoiceLanguages])];
  }

  function setVoiceLanguagePickerOpen(open) {
    $("#voice-language-select").hidden = !open;
    $("#voice-language-add").setAttribute("aria-expanded", String(open));
    $("#voice-language-add").textContent = open ? "Đóng" : "+ Thêm ngôn ngữ";
  }

  function renderVoiceLanguagePicker() {
    const picker = $("#voice-language-select");
    const shown = shownVoiceLanguages();
    const hiddenLanguages = [...new Set(voices.map((voice) => voiceLanguage(voice.lang)))]
      .filter((code) => code && !shown.includes(code))
      .sort((a, b) => languageName(a).localeCompare(languageName(b), "vi"));
    const placeholder = new Option("Chọn ngôn ngữ…", "");
    placeholder.disabled = true;
    placeholder.selected = true;
    picker.replaceChildren(placeholder);
    for (const code of hiddenLanguages) {
      const count = voices.filter((voice) => voiceLanguage(voice.lang) === code).length;
      picker.append(new Option(`${languageName(code)} (${count} giọng)`, code));
    }
    if (extraVoiceLanguages.length) picker.append(new Option("Bỏ các ngôn ngữ đã thêm", "reset"));
    const addButton = $("#voice-language-add");
    addButton.hidden = picker.options.length <= 1;
    if (addButton.hidden) setVoiceLanguagePickerOpen(false);
  }

  function loadVoices() {
    voices = nativeSpeech ? nativeVoices : (synth ? synth.getVoices() : []);
    const previous = voiceSelect.value;
    voiceSelect.replaceChildren();
    const onlineGroup = document.createElement("optgroup");
    onlineGroup.label = "Giọng trực tuyến";
    const onlineOption = document.createElement("option");
    onlineOption.value = "online-vi";
    onlineOption.textContent = "Tiếng Việt · Google";
    onlineGroup.append(onlineOption);
    voiceSelect.append(onlineGroup);
    const viVoices = voices.filter((voice) => voiceLanguage(voice.lang) === "vi");
    const voiceGroups = shownVoiceLanguages().map((code) => [
      code === "vi" ? "Tiếng Việt" : languageName(code),
      voices.filter((voice) => voiceLanguage(voice.lang) === code),
    ]);
    for (const [label, list] of voiceGroups) {
      if (!list.length) continue;
      const group = document.createElement("optgroup");
      group.label = label;
      for (const voice of list) {
        const option = document.createElement("option");
        option.value = voice.voiceURI;
        option.textContent = `${voice.name} (${voice.lang})`;
        group.append(option);
      }
      voiceSelect.append(group);
    }
    const preferred = viVoices.find((voice) => /female|linh|an|hoai|vietnam/i.test(voice.name)) || viVoices[0];
    const available = [...voiceSelect.options].map((option) => option.value);
    voiceSelect.value = available.includes(previous)
      ? previous
      : (preferred ? preferred.voiceURI : "online-vi");
    voiceSelect.disabled = false;
    renderVoiceLanguagePicker();
  }

  $("#voice-language-add").addEventListener("click", () => {
    setVoiceLanguagePickerOpen($("#voice-language-select").hidden);
  });
  $("#voice-language-select").addEventListener("change", (event) => {
    const code = event.target.value;
    extraVoiceLanguages = code === "reset" ? [] : [...extraVoiceLanguages, code];
    setVoiceLanguagePickerOpen(false);
    loadVoices();
    const firstVoice = voices.find((voice) => voiceLanguage(voice.lang) === code);
    if (firstVoice) {
      voiceSelect.value = firstVoice.voiceURI;
      voiceSelect.dispatchEvent(new Event("change"));
    }
    saveSetting("extraVoiceLanguages", extraVoiceLanguages).catch((error) => {
      console.error("Không thể lưu ngôn ngữ giọng đọc:", error);
    });
  });

  $("#open-book").addEventListener("click", () => fileInput.click());
  $("#home-button").addEventListener("click", showHomeView);
  $("#welcome-open").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    openBook(fileInput.files?.[0]);
    fileInput.value = "";
  });
  $("#prev-page").addEventListener("click", () => rendition?.prev());
  $("#next-page").addEventListener("click", () => rendition?.next());
  playButton.addEventListener("click", startSpeech);
  $("#prev-chapter").addEventListener("click", () => goToAdjacentChapter(-1));
  $("#next-chapter").addEventListener("click", () => goToAdjacentChapter(1));
  document.addEventListener("visibilitychange", syncWakeLock);
  stopButton.addEventListener("click", stopSpeech);
  voiceSelect.addEventListener("change", () => {
    if ((synth && synth.speaking) || !audioPlayer.paused || isPaused || isNativeSpeaking()) {
      stopSpeech();
      setSpeechStatus("Giọng đọc đã thay đổi");
    }
  });
  $("#rate-range").addEventListener("input", (event) => {
    $("#rate-value").value = `${Number(event.target.value).toFixed(1)}×`;
    if (usingOnlineVoice && audioPlayer.src) audioPlayer.playbackRate = Number(event.target.value);
    if (currentUtterance && synth?.speaking) currentUtterance.rate = Number(event.target.value);
    if (isNativeSpeaking()) nativeSpeech.setOptions({ rate: Number(event.target.value) }).catch(() => {});
  });
  $("#volume-range").addEventListener("input", (event) => {
    const volume = Number(event.target.value);
    $("#volume-value").value = `${Math.round(volume * 100)}%`;
    audioPlayer.volume = volume;
    if (currentUtterance && synth?.speaking) currentUtterance.volume = volume;
    if (isNativeSpeaking()) nativeSpeech.setOptions({ volume }).catch(() => {});
  });
  $("#font-smaller").addEventListener("click", () => {
    updateReaderPreference("fontSize", Math.max(70, fontSize - 10));
    persistReaderPreferences();
  });
  $("#font-larger").addEventListener("click", () => {
    updateReaderPreference("fontSize", Math.min(220, fontSize + 10));
    persistReaderPreferences();
  });
  $("#reader-font").addEventListener("change", (event) => {
    updateReaderPreference("fontFamily", event.target.value);
    persistReaderPreferences();
  });
  $("#reader-font-size").addEventListener("input", (event) => {
    updateReaderPreference("fontSize", Number(event.target.value));
  });
  $("#reader-font-size").addEventListener("change", persistReaderPreferences);
  $("#reader-line-height").addEventListener("input", (event) => {
    updateReaderPreference("lineHeight", Number(event.target.value));
  });
  $("#reader-line-height").addEventListener("change", persistReaderPreferences);
  $("#reader-margin").addEventListener("input", (event) => {
    updateReaderPreference("margin", Number(event.target.value));
  });
  $("#reader-margin").addEventListener("change", () => {
    applyReaderMargin();
    persistReaderPreferences();
  });
  $("#reader-brightness").addEventListener("input", (event) => {
    updateReaderPreference("brightness", Number(event.target.value) / 100);
    applyBrightness();
  });
  $("#reader-brightness").addEventListener("change", persistReaderPreferences);
  $("#reader-brightness-auto").addEventListener("change", (event) => {
    updateReaderPreference("brightness", event.target.checked ? null : Number($("#reader-brightness").value) / 100);
    applyBrightness();
    persistReaderPreferences();
  });
  if (nativeSpeech) $("#reader-brightness-setting").hidden = false;
  $("#reader-text-color").addEventListener("input", (event) => {
    updateReaderPreference("textColor", event.target.value);
  });
  $("#reader-text-color").addEventListener("change", persistReaderPreferences);
  $("#reader-background-color").addEventListener("input", (event) => {
    updateReaderPreference("backgroundColor", event.target.value);
  });
  $("#reader-background-color").addEventListener("change", persistReaderPreferences);
  $("#reader-settings-reset").addEventListener("click", () => {
    readerPreferences = { ...defaultReaderPreferences };
    applyTheme();
    syncReaderSettingsControls();
    applyReaderPreferences();
    applyReaderMargin();
    applyBrightness();
    persistReaderPreferences();
  });
  $("#hide-audio-panel").addEventListener("click", () => setAudioPanelOpen(false));
  $("#show-audio-panel").addEventListener("click", () => {
    const isOpen = !$("#app-shell").classList.contains("audio-panel-hidden");
    setAudioPanelOpen(!isOpen);
    if (!isOpen) showReaderChrome();
  });
  $("#reading-mode-toggle").addEventListener("click", () => {
    if (!rendition) return;
    readingMode = readingMode === "scrolled-doc" ? "paginated" : "scrolled-doc";
    rendition.flow(readingMode);
    updateReadingModeControl();
  });
  $("#reader-toolbar").addEventListener("pointerdown", () => {
    if (document.body.classList.contains("reader-chrome-visible")) showReaderChrome();
  }, { passive: true });
  $("#reader-column").addEventListener("scroll", hideReaderChrome, { capture: true, passive: true });
  document.addEventListener("fullscreenchange", resizeRenditionToViewer);
  $("#theme-toggle").addEventListener("click", () => {
    const current = readerThemeOrder.indexOf(readerPreferences.theme);
    const theme = readerThemeOrder[(current + 1) % readerThemeOrder.length];
    readerPreferences = {
      ...readerPreferences,
      theme,
      textColor: readerThemes[theme].textColor,
      backgroundColor: readerThemes[theme].backgroundColor,
    };
    applyTheme();
    syncReaderSettingsControls();
    applyReaderPreferences();
    persistReaderPreferences();
  });
  $("#show-sidebar").addEventListener("click", () => $("#sidebar").classList.add("is-open"));
  $("#sidebar-toggle").addEventListener("click", () => $("#sidebar").classList.remove("is-open"));
  $("#toc-jump-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("#toc-jump-input");
    if (!input.reportValidity()) return;
    goToChapter(Number(input.value));
  });

  document.addEventListener("keydown", (event) => {
    if (event.target.matches("input, select, textarea, button")) return;
    if (event.key === "ArrowLeft" && rendition) rendition.prev();
    if (event.key === "ArrowRight" && rendition) rendition.next();
    if (event.code === "Space" && book) {
      event.preventDefault();
      startSpeech();
    }
  });

  const stage = $("#reader-stage");
  stage.addEventListener("dragover", (event) => {
    event.preventDefault();
    stage.classList.add("is-dragging");
  });
  stage.addEventListener("dragleave", (event) => {
    if (!stage.contains(event.relatedTarget)) stage.classList.remove("is-dragging");
  });
  stage.addEventListener("drop", (event) => {
    event.preventDefault();
    stage.classList.remove("is-dragging");
    openBook(event.dataTransfer?.files?.[0]);
  });

  // iOS chỉ hiện nút chương trước/sau trên màn hình khóa khi các thao tác tua bị tắt (null).
  function registerMediaSessionHandlers() {
    if (!("mediaSession" in navigator)) return;
    const mediaActions = {
      play: () => {
        if (isPaused) startSpeech();
      },
      pause: () => {
        if (!isPaused && (speechQueue.length || !audioPlayer.paused)) startSpeech();
      },
      stop: stopSpeech,
      previoustrack: () => goToAdjacentChapter(-1),
      nexttrack: () => goToAdjacentChapter(1),
      seekbackward: null,
      seekforward: null,
      seekto: null,
    };
    for (const [action, handler] of Object.entries(mediaActions)) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // Trình duyệt không hỗ trợ thao tác này trên màn hình khóa.
      }
    }
  }
  registerMediaSessionHandlers();

  loadVoices();
  if (nativeSpeech) {
    nativeSpeech.addListener("state", ({ state }) => handleNativeState(state));
    nativeSpeech.addListener("chapterChange", ({ index, title }) => handleNativeChapter(index, title));
    nativeSpeech.getVoices().then(({ voices: list }) => {
      nativeVoices = (list || []).map((voice) => ({ voiceURI: voice.id, name: voice.name, lang: voice.lang }));
      loadVoices();
    }).catch((error) => {
      console.error("Không thể đọc danh sách giọng của máy:", error);
    });
  }
  getSetting("extraVoiceLanguages").then((saved) => {
    if (!Array.isArray(saved) || !saved.length) return;
    extraVoiceLanguages = saved.filter((code) => typeof code === "string");
    loadVoices();
  }).catch((error) => {
    console.error("Không thể đọc ngôn ngữ giọng đọc đã lưu:", error);
  });
  if (synth) {
    synth.addEventListener("voiceschanged", loadVoices);
  }
  audioPlayer.volume = Number($("#volume-range").value);
  applyTheme();
  updateReadingModeControl();
  syncReaderSettingsControls();
  getReaderPreferences().then((preferences) => {
    if (!preferences) return;
    const fontSizeValue = Number(preferences.fontSize);
    const lineHeightValue = Number(preferences.lineHeight);
    const marginValue = Number(preferences.margin);
    const brightnessValue = preferences.brightness === null || preferences.brightness === undefined ? null : Number(preferences.brightness);
    readerPreferences = {
      fontFamily: Object.hasOwn(readerFontFamilies, preferences.fontFamily)
        ? preferences.fontFamily
        : defaultReaderPreferences.fontFamily,
      fontSize: Number.isFinite(fontSizeValue) && fontSizeValue >= 70 && fontSizeValue <= 220
        ? Math.round(fontSizeValue / 10) * 10
        : defaultReaderPreferences.fontSize,
      lineHeight: Number.isFinite(lineHeightValue) && lineHeightValue >= 1.2 && lineHeightValue <= 2.6
        ? lineHeightValue
        : defaultReaderPreferences.lineHeight,
      margin: Number.isFinite(marginValue) && marginValue >= 0 && marginValue <= 60
        ? marginValue
        : defaultReaderPreferences.margin,
      brightness: brightnessValue !== null && brightnessValue >= 0.05 && brightnessValue <= 1
        ? brightnessValue
        : null,
      theme: Object.hasOwn(readerThemes, preferences.theme) ? preferences.theme : defaultReaderPreferences.theme,
      textColor: /^#[0-9a-f]{6}$/i.test(preferences.textColor)
        ? preferences.textColor
        : defaultReaderPreferences.textColor,
      backgroundColor: /^#[0-9a-f]{6}$/i.test(preferences.backgroundColor)
        ? preferences.backgroundColor
        : defaultReaderPreferences.backgroundColor,
    };
    applyTheme();
    syncReaderSettingsControls();
    applyReaderPreferences();
    applyBrightness();
    setReaderSettingsStatus("Đã khôi phục tùy chỉnh");
  }).catch((error) => {
    console.error("Không thể khôi phục tùy chỉnh hiển thị:", error);
    setReaderSettingsStatus("Không thể đọc tùy chỉnh đã lưu", true);
  }).then(() => renderLibrary()).catch((error) => {
    console.error("Không thể tải thư viện sách:", error);
    setLibraryStatus("Không thể đọc thư viện sách trên thiết bị.", true);
  });
})();
