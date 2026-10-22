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
  const synth = window.speechSynthesis;
  const audioPlayer = new Audio();
  const defaultReaderPreferences = {
    fontFamily: "georgia",
    fontSize: 100,
    textColor: "#35372f",
    backgroundColor: "#fffefa",
  };
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
    $("#reader-text-color").value = readerPreferences.textColor;
    $("#reader-background-color").value = readerPreferences.backgroundColor;
  }

  function applyReaderPreferences() {
    fontSize = readerPreferences.fontSize;
    viewer.style.backgroundColor = readerPreferences.backgroundColor;
    if (!rendition) return;

    const fontFamily = readerFontFamilies[readerPreferences.fontFamily];
    rendition.themes.default({
      html: { background: `${readerPreferences.backgroundColor} !important` },
      body: {
        color: `${readerPreferences.textColor} !important`,
        background: `${readerPreferences.backgroundColor} !important`,
        "font-family": `${fontFamily} !important`,
        "font-size": `${fontSize}% !important`,
        "line-height": "1.85 !important",
        padding: "12px 24px",
      },
      "body *": {
        color: `${readerPreferences.textColor} !important`,
        "font-family": `${fontFamily} !important`,
      },
      "h1, h2, h3": { "line-height": "1.4" },
      p: { "line-height": "1.85", "text-align": "justify" },
    });
    rendition.themes.fontSize(`${fontSize}%`);
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
      const titleText = record.title || record.name.replace(/\.epub$/i, "");
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
    if (window.innerWidth <= 650) {
      $("#app-shell").classList.add("audio-panel-hidden");
      $("#hide-audio-panel").setAttribute("aria-expanded", "false");
      $("#show-audio-panel").hidden = false;
      $("#show-audio-panel").setAttribute("aria-expanded", "false");
    }
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

  $("#reader-controls-reveal").addEventListener("click", showReaderChrome);

  function bindReaderGestures(contentDocument) {
    if (!contentDocument || readerGestureDocuments.has(contentDocument)) return;
    readerGestureDocuments.add(contentDocument);
    let pointerStart = null;
    let touchStart = null;
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
      if (!handleReaderLink(event)) showReaderChrome();
    }, { capture: true });
    contentDocument.addEventListener("touchstart", (event) => {
      const touch = event.changedTouches[0];
      if (touch) touchStart = { x: touch.clientX, y: touch.clientY };
    }, { capture: true, passive: true });
    contentDocument.addEventListener("touchmove", (event) => {
      const touch = event.changedTouches[0];
      if (!touch || !touchStart) return;
      if (Math.hypot(touch.clientX - touchStart.x, touch.clientY - touchStart.y) > 12) {
        touchStart = null;
        hideReaderChrome();
      }
    }, { capture: true, passive: true });
    contentDocument.addEventListener("touchend", (event) => {
      if (!touchStart) return;
      const touch = event.changedTouches[0];
      if (!touch) return;
      const distance = Math.hypot(touch.clientX - touchStart.x, touch.clientY - touchStart.y);
      touchStart = null;
      if (distance > 12) return;
      if (handleReaderLink(event, true)) return;
      showReaderChrome();
    }, { capture: true, passive: false });
    contentDocument.addEventListener("touchcancel", () => {
      touchStart = null;
      hideReaderChrome();
    }, { capture: true, passive: true });
    contentDocument.addEventListener("pointerdown", (event) => {
      pointerStart = { x: event.clientX, y: event.clientY, time: Date.now() };
    }, { capture: true, passive: true });
    contentDocument.addEventListener("pointermove", (event) => {
      if (!pointerStart) return;
      const distance = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y);
      if (distance > 12) {
        pointerStart = null;
        hideReaderChrome();
      }
    }, { capture: true, passive: true });
    contentDocument.addEventListener("pointerup", (event) => {
      if (!pointerStart) return;
      const distance = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y);
      const duration = Date.now() - pointerStart.time;
      pointerStart = null;
      if (distance <= 12 && duration < 500) showReaderChrome();
    }, { capture: true, passive: true });
    contentDocument.addEventListener("pointercancel", () => {
      pointerStart = null;
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

  function updateSpeechButtons(isPlaying = false) {
    playButton.classList.toggle("is-playing", isPlaying);
    $("#play-label").textContent = isPlaying ? (isPaused ? "Tiếp tục nghe" : "Đang đọc") : "Nghe chương này";
  }

  function enableReading(enabled) {
    $("#prev-page").disabled = !enabled;
    $("#next-page").disabled = !enabled;
    playButton.disabled = !enabled;
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

  async function getChapterText() {
    const renderedText = getRenderedChapterText();
    if (renderedText) return renderedText;

    const location = rendition?.currentLocation();
    const section = location?.start?.index !== undefined
      ? book.spine.get(location.start.index)
      : null;
    if (!section) throw new Error("Không xác định được nội dung chương này.");

    const doc = await section.load(book.load.bind(book));
    try {
      return readableTextFromDocument(doc);
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

  function stopSpeech() {
    if (synth) synth.cancel();
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
      updateSpeechButtons(false);
      setSpeechStatus("Đã đọc xong chương này");
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
      audioPlayer.play().catch((error) => {
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
    const utterance = new SpeechSynthesisUtterance(speechQueue[speechIndex]);
    const selectedVoice = voiceSelect.value;
    utterance.voice = voices.find((voice) => voice.voiceURI === selectedVoice) || null;
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
    currentUtterance = utterance;
    synth.speak(utterance);
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
    const title = metadata.title?.trim() || fileName.replace(/\.epub$/i, "");
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

  async function openBook(file, savedRecord = null) {
    if (!file && !savedRecord) return;
    const fileName = savedRecord?.name || file.name;
    if (!/\.epub$/i.test(fileName) && file?.type !== "application/epub+zip") {
      setError("Vui lòng chọn tệp sách có định dạng .epub.");
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
      const bookData = savedRecord?.data || await readFileAsArrayBuffer(file);
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
            title: metadata.title?.trim() || file.name.replace(/\.epub$/i, ""),
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
            title: metadata.title?.trim() || savedRecord.title || fileName.replace(/\.epub$/i, ""),
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

  function loadVoices() {
    voices = synth ? synth.getVoices() : [];
    const previous = voiceSelect.value;
    voiceSelect.replaceChildren();
    const onlineGroup = document.createElement("optgroup");
    onlineGroup.label = "Giọng trực tuyến";
    const onlineOption = document.createElement("option");
    onlineOption.value = "online-vi";
    onlineOption.textContent = "Tiếng Việt · Google";
    onlineGroup.append(onlineOption);
    voiceSelect.append(onlineGroup);
    const viVoices = voices.filter((voice) => voice.lang.toLowerCase().startsWith("vi"));
    const otherVoices = voices.filter((voice) => !voice.lang.toLowerCase().startsWith("vi"));
    for (const [label, list] of [["Tiếng Việt", viVoices], ["Ngôn ngữ khác", otherVoices]]) {
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
    const preferred = viVoices.find((voice) => /female|linh|an|hoai|vietnam/i.test(voice.name)) || viVoices[0] || voices[0];
    const available = [...voices.map((voice) => voice.voiceURI), "online-vi"];
    voiceSelect.value = available.includes(previous)
      ? previous
      : (viVoices.length ? preferred.voiceURI : "online-vi");
    voiceSelect.disabled = false;
  }

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
  stopButton.addEventListener("click", stopSpeech);
  voiceSelect.addEventListener("change", () => {
    if ((synth && synth.speaking) || !audioPlayer.paused || isPaused) {
      stopSpeech();
      setSpeechStatus("Giọng đọc đã thay đổi");
    }
  });
  $("#rate-range").addEventListener("input", (event) => {
    $("#rate-value").value = `${Number(event.target.value).toFixed(1)}×`;
    if (usingOnlineVoice && audioPlayer.src) audioPlayer.playbackRate = Number(event.target.value);
    if (currentUtterance && synth?.speaking) currentUtterance.rate = Number(event.target.value);
  });
  $("#volume-range").addEventListener("input", (event) => {
    const volume = Number(event.target.value);
    $("#volume-value").value = `${Math.round(volume * 100)}%`;
    audioPlayer.volume = volume;
    if (currentUtterance && synth?.speaking) currentUtterance.volume = volume;
  });
  $("#font-smaller").addEventListener("click", () => {
    updateReaderPreference("fontSize", Math.max(80, fontSize - 10));
    persistReaderPreferences();
  });
  $("#font-larger").addEventListener("click", () => {
    updateReaderPreference("fontSize", Math.min(180, fontSize + 10));
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
    syncReaderSettingsControls();
    applyReaderPreferences();
    persistReaderPreferences();
  });
  $("#hide-audio-panel").addEventListener("click", () => {
    $("#app-shell").classList.add("audio-panel-hidden");
    $("#hide-audio-panel").setAttribute("aria-expanded", "false");
    $("#show-audio-panel").hidden = false;
    $("#show-audio-panel").setAttribute("aria-expanded", "false");
    resizeRenditionToViewer();
  });
  $("#show-audio-panel").addEventListener("click", () => {
    $("#app-shell").classList.remove("audio-panel-hidden");
    $("#hide-audio-panel").setAttribute("aria-expanded", "true");
    $("#show-audio-panel").hidden = true;
    showReaderChrome();
    resizeRenditionToViewer();
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
    document.body.classList.toggle("theme-sepia");
    if (!document.body.classList.contains("theme-sepia")) document.body.classList.toggle("theme-dark");
    else document.body.classList.remove("theme-dark");
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

  loadVoices();
  if (synth) {
    synth.addEventListener("voiceschanged", loadVoices);
  }
  audioPlayer.volume = Number($("#volume-range").value);
  updateReadingModeControl();
  syncReaderSettingsControls();
  getReaderPreferences().then((preferences) => {
    if (!preferences) return;
    const fontSizeValue = Number(preferences.fontSize);
    readerPreferences = {
      fontFamily: Object.hasOwn(readerFontFamilies, preferences.fontFamily)
        ? preferences.fontFamily
        : defaultReaderPreferences.fontFamily,
      fontSize: Number.isFinite(fontSizeValue) && fontSizeValue >= 80 && fontSizeValue <= 180
        ? Math.round(fontSizeValue / 10) * 10
        : defaultReaderPreferences.fontSize,
      textColor: /^#[0-9a-f]{6}$/i.test(preferences.textColor)
        ? preferences.textColor
        : defaultReaderPreferences.textColor,
      backgroundColor: /^#[0-9a-f]{6}$/i.test(preferences.backgroundColor)
        ? preferences.backgroundColor
        : defaultReaderPreferences.backgroundColor,
    };
    syncReaderSettingsControls();
    applyReaderPreferences();
    setReaderSettingsStatus("Đã khôi phục tùy chỉnh");
  }).catch((error) => {
    console.error("Không thể khôi phục tùy chỉnh hiển thị:", error);
    setReaderSettingsStatus("Không thể đọc tùy chỉnh đã lưu", true);
  }).then(() => renderLibrary()).catch((error) => {
    console.error("Không thể tải thư viện sách:", error);
    setLibraryStatus("Không thể đọc thư viện sách trên thiết bị.", true);
  });
})();
