const { app, BrowserWindow, session, safeStorage, net } = require('electron');
const crypto = require('crypto');
const http = require('http');
const netSockets = require('net');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// electron/ytmusicAuth.cjs
// YouTube Music 认证管理：管理外部浏览器/嵌入式登录窗口、CDP Cookie 提取、SAPISIDHASH 签名与 Innertube API 代理请求。

const CHROME_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PARTITION = 'persist:ytmusic';
const STORE_KEY = 'YTMUSIC_AUTH_USER';
const YTMUSIC_ORIGIN = 'https://music.youtube.com';

/**
 * 计算 Google SAPISID 认证哈希
 */
function generateSapisidHash(sapisid, origin = YTMUSIC_ORIGIN) {
  const timestamp = Math.floor(Date.now() / 1000);
  const hash = crypto.createHash('sha1').update(`${timestamp} ${sapisid} ${origin}`).digest('hex');
  return `SAPISIDHASH ${timestamp}_${hash}`;
}

/**
 * 构造 YouTube Music Innertube API 请求头
 */
function buildInnertubeHeaders(cookies, sapisid) {
  const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const headers = {
    'User-Agent': CHROME_USER_AGENT,
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Content-Type': 'application/json',
    'Origin': YTMUSIC_ORIGIN,
    'Referer': `${YTMUSIC_ORIGIN}/`,
    'X-Origin': YTMUSIC_ORIGIN,
    'X-YouTube-Client-Name': '67',
    'X-YouTube-Client-Version': '1.20240101.01.00',
    'Cookie': cookieString,
  };
  if (sapisid) {
    headers['Authorization'] = generateSapisidHash(sapisid);
  }
  return headers;
}

/**
 * 查找系统安装的 Chromium 内核浏览器（Chrome, Edge, Brave, Chromium 等）
 */
function findChromiumBrowser() {
  const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || '';

  const candidates = [];
  if (process.platform === 'win32') {
    candidates.push(
      path.join(programFiles, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(programFilesX86, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(localAppData, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(programFilesX86, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(programFiles, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(localAppData, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(programFiles, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
      path.join(localAppData, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe')
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
      '/usr/bin/brave-browser'
    );
  }

  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

/**
 * 获取用于 CDP 远程调试的可用本地端口
 */
function getAvailablePort(startPort = 19333) {
  return new Promise((resolve) => {
    const server = netSockets.createServer();
    server.listen(startPort, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', () => {
      resolve(getAvailablePort(startPort + 1));
    });
  });
}

/**
 * 轮询 CDP /json/version 端点获取 WebSocket 调试 URL
 */
function fetchCdpWsUrl(port, maxAttempts = 60, delayMs = 300) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const poll = () => {
      attempts++;
      const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.webSocketDebuggerUrl) {
              return resolve(json.webSocketDebuggerUrl);
            }
          } catch (_) {}
          if (attempts >= maxAttempts) return reject(new Error('CDP version response missing WS url'));
          setTimeout(poll, delayMs);
        });
      });
      req.on('error', () => {
        if (attempts >= maxAttempts) return reject(new Error('CDP connection timed out'));
        setTimeout(poll, delayMs);
      });
    };
    poll();
  });
}

/**
 * 将 CDP 捕获的 Cookie 导入到 Electron 会话中
 */
async function importCdpCookiesToSession(ses, cookies) {
  for (const c of cookies) {
    if (!c.domain || (!c.domain.includes('youtube.com') && !c.domain.includes('google.com'))) {
      continue;
    }
    try {
      const domainWithoutDot = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
      const protocol = c.secure ? 'https' : 'http';
      const cookiePath = (c.path && c.path.startsWith('/')) ? c.path : '/';
      const url = `${protocol}://${domainWithoutDot}${cookiePath}`;

      const cookieDetails = {
        url,
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: cookiePath,
        secure: Boolean(c.secure),
        httpOnly: Boolean(c.httpOnly),
      };

      if (typeof c.expires === 'number' && c.expires > 0) {
        cookieDetails.expirationDate = c.expires;
      }

      if (c.sameSite === 'None') {
        cookieDetails.sameSite = 'no_restriction';
      } else if (c.sameSite === 'Lax') {
        cookieDetails.sameSite = 'lax';
      } else if (c.sameSite === 'Strict') {
        cookieDetails.sameSite = 'strict';
      }

      await ses.cookies.set(cookieDetails);
    } catch (_e) {
      // 忽略单个非核心 cookie 的格式错误
    }
  }
  try {
    await ses.cookies.flushStore();
  } catch (_) {}
}

/**
 * 创建 YouTube Music 认证管理控制器
 */
function createYtmusicAuth({ store, getMainWindow }) {
  let loginWindow = null;
  let activeExternalLogin = null;
  let ses = null;
  let interceptorRegistered = false;

  const audioCache = new Map(); // videoId -> { url, expiresAt }
  const pendingResolvers = new Map(); // webContentsId -> { resolve, timer, videoId, win }

  /**
   * 延迟获取分区会话，确保仅在 app ready 后创建
   */
  function getSession() {
    if (!ses) {
      ses = session.fromPartition(PARTITION);
      ses.setUserAgent(CHROME_USER_AGENT);
      if (!interceptorRegistered) {
        interceptorRegistered = true;
        ses.webRequest.onBeforeRequest({ urls: ['*://*.googlevideo.com/videoplayback*'] }, (details, callback) => {
          callback({});
          const pending = pendingResolvers.get(details.webContentsId);
          const isAudioStream = details.url.includes('mime=audio') ||
            details.url.includes('audio') ||
            details.url.includes('itag=251') ||
            details.url.includes('itag=140') ||
            details.url.includes('itag=250') ||
            details.url.includes('itag=249');
          if (pending && isAudioStream) {
            pendingResolvers.delete(details.webContentsId);
            clearTimeout(pending.timer);

            try {
              const urlObj = new URL(details.url);
              urlObj.searchParams.delete('range');
              urlObj.searchParams.delete('rn');
              urlObj.searchParams.delete('rbuf');
              urlObj.searchParams.delete('ump');
              urlObj.searchParams.delete('srfvp');
              const cleanUrl = urlObj.toString();
              const expireSec = parseInt(urlObj.searchParams.get('expire') || '0', 10);
              const expiresAt = expireSec ? expireSec * 1000 : Date.now() + 3600 * 1000 * 4;

              audioCache.set(pending.videoId, { url: cleanUrl, expiresAt });
              pending.resolve({ url: cleanUrl, expiresAt });
            } catch (_e) {
              pending.resolve({ url: details.url, expiresAt: Date.now() + 3600 * 1000 * 4 });
            }

            try {
              if (pending.win && !pending.win.isDestroyed()) {
                pending.win.destroy();
              }
            } catch (_) {}
          }
        });
      }
    }
    return ses;
  }

  if (app && typeof app.whenReady === 'function') {
    app.whenReady().then(() => {
      try {
        getSession();
      } catch (err) {
        console.warn('[YTMusicAuth] Failed to initialize session on app ready', err);
      }
    });
  }

  /**
   * 获取持久化分区中的全部相关 Cookie
   */
  async function getPartitionCookies() {
    const s = getSession();
    const cookies = await s.cookies.get({ domain: '.youtube.com' });
    const musicCookies = await s.cookies.get({ domain: 'music.youtube.com' });
    const all = [...cookies, ...musicCookies];
    const unique = new Map();
    for (const c of all) {
      unique.set(c.name, c);
    }
    return Array.from(unique.values());
  }

  /**
   * 从 Cookie 列表中查找 SAPISID 或安全变体
   */
  function extractSapisid(cookies) {
    const sapisidCookie = cookies.find(c => c.name === 'SAPISID' || c.name === '__Secure-3PAPISID');
    return sapisidCookie ? sapisidCookie.value : null;
  }

  /**
   * 通过 account_menu 接口拉取当前登录用户的资料
   */
  async function fetchUserProfile(cookies, sapisid) {
    try {
      const headers = buildInnertubeHeaders(cookies, sapisid);
      const payload = {
        context: {
          client: {
            clientName: 'WEB_REMIX',
            clientVersion: '1.20240101.01.00',
            hl: 'en',
            gl: 'US',
          },
        },
      };

      const res = await fetch(`${YTMUSIC_ORIGIN}/youtubei/v1/account/account_menu`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        return null;
      }

      const json = await res.json();
      const header = json?.actions?.[0]?.openPopupAction?.popup?.multiPageMenuRenderer?.header?.activeAccountHeaderRenderer;
      if (header) {
        const nickname = header.accountName?.runs?.[0]?.text || 'YouTube Music User';
        const email = header.email?.runs?.[0]?.text || '';
        const handle = header.channelHandle?.runs?.[0]?.text || '';
        const avatarUrl = header.accountPhoto?.thumbnails?.slice(-1)?.[0]?.url;
        return {
          id: handle || email || 'ytmusic_user',
          nickname,
          avatarUrl,
        };
      }
    } catch (err) {
      console.warn('[YTMusicAuth] Failed to fetch user profile via account_menu', err);
    }

    return {
      id: 'ytmusic_user',
      nickname: 'YouTube Music User',
    };
  }

  /**
   * 检查当前会话登录状态
   */
  async function getAuth() {
    const cookies = await getPartitionCookies();
    const sapisid = extractSapisid(cookies);
    if (!sapisid) {
      return null;
    }

    const cachedUser = store.get(STORE_KEY);
    if (cachedUser && cachedUser.id) {
      return cachedUser;
    }

    const user = await fetchUserProfile(cookies, sapisid);
    if (user) {
      store.set(STORE_KEY, user);
    }
    return user;
  }

  /**
   * 打开外部系统浏览器登录，通过 CDP 监听并捕获登录 Cookie
   */
  async function openExternalBrowserLogin(browserPath) {
    if (activeExternalLogin) {
      return activeExternalLogin.promise;
    }

    let resolvePromise;
    const loginPromise = new Promise((resolve) => {
      resolvePromise = resolve;
    });

    activeExternalLogin = {
      promise: loginPromise,
    };

    try {
      const port = await getAvailablePort(19333);
      const profileDir = path.join(app.getPath('userData'), 'ytmusic_login_browser_profile');
      if (!fs.existsSync(profileDir)) {
        fs.mkdirSync(profileDir, { recursive: true });
      }

      const targetUrl = 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https://music.youtube.com/';
      const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=950,850',
        targetUrl,
      ];

      const proc = spawn(browserPath, args, {
        detached: false,
        stdio: 'ignore',
      });

      let ws = null;
      let pollTimer = null;
      let isResolved = false;
      let cdpRequestId = 1;
      let timeoutTimer = null;

      const cleanup = () => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        try {
          if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
            ws.close();
          }
        } catch (_) {}
        try {
          if (proc && !proc.killed) {
            proc.kill();
          }
        } catch (_) {}
        activeExternalLogin = null;
      };

      const finishWithUser = async (user) => {
        if (isResolved) return;
        isResolved = true;
        cleanup();
        resolvePromise(user);
      };

      timeoutTimer = setTimeout(() => {
        if (!isResolved) {
          finishWithUser(null);
        }
      }, 5 * 60 * 1000);

      proc.on('exit', () => {
        if (!isResolved) {
          finishWithUser(null);
        }
      });

      const wsUrl = await fetchCdpWsUrl(port);
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        const queryCookies = () => {
          if (isResolved || ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ id: cdpRequestId++, method: 'Storage.getCookies' }));
        };
        queryCookies();
        pollTimer = setInterval(queryCookies, 1500);
      };

      ws.onmessage = async (event) => {
        if (isResolved) return;
        try {
          const data = JSON.parse(event.data);
          if (!data.result || !Array.isArray(data.result.cookies)) return;

          const cookies = data.result.cookies;
          const sapisidCookie = cookies.find(
            c => (c.name === 'SAPISID' || c.name === '__Secure-3PAPISID') &&
                 (c.domain.includes('youtube.com') || c.domain.includes('google.com'))
          );

          if (sapisidCookie && sapisidCookie.value) {
            if (pollTimer) {
              clearInterval(pollTimer);
              pollTimer = null;
            }

            const s = getSession();
            await importCdpCookiesToSession(s, cookies);

            const partitionCookies = await getPartitionCookies();
            const sapisid = extractSapisid(partitionCookies) || sapisidCookie.value;

            const user = await fetchUserProfile(partitionCookies, sapisid);
            if (user) {
              store.set(STORE_KEY, user);
            }

            const mainWindow = typeof getMainWindow === 'function' ? getMainWindow() : null;
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('ytmusic-auth-changed', user);
            }

            try {
              ws.send(JSON.stringify({ id: cdpRequestId++, method: 'Browser.close' }));
            } catch (_) {}

            setTimeout(() => {
              finishWithUser(user);
            }, 800);
          }
        } catch (err) {
          console.warn('[YTMusicAuth] CDP message parse error:', err);
        }
      };

      ws.onerror = (err) => {
        console.warn('[YTMusicAuth] CDP WebSocket error:', err?.message || err);
      };

      ws.onclose = () => {
        if (!isResolved) {
          setTimeout(() => {
            if (!isResolved) {
              finishWithUser(null);
            }
          }, 1000);
        }
      };
    } catch (err) {
      console.warn('[YTMusicAuth] Failed to launch external browser for login, falling back to embedded window:', err);
      activeExternalLogin = null;
      return openInternalLoginWindow();
    }

    return loginPromise;
  }

  /**
   * 打开嵌入式独立登录弹窗（备用模式）
   */
  function openInternalLoginWindow() {
    return new Promise((resolve) => {
      if (loginWindow && !loginWindow.isDestroyed()) {
        loginWindow.focus();
        resolve(null);
        return;
      }

      loginWindow = new BrowserWindow({
        width: 650,
        height: 780,
        title: 'Sign in - YouTube Music',
        autoHideMenuBar: true,
        webPreferences: {
          partition: PARTITION,
          nodeIntegration: false,
          contextIsolation: true,
        },
      });

      loginWindow.webContents.setUserAgent(CHROME_USER_AGENT);
      loginWindow.loadURL('https://accounts.google.com/ServiceLogin?service=youtube&continue=https://music.youtube.com/');

      let resolved = false;

      const checkAuthSuccess = async () => {
        if (resolved) return;
        const cookies = await getPartitionCookies();
        const sapisid = extractSapisid(cookies);
        if (sapisid) {
          resolved = true;
          const user = await fetchUserProfile(cookies, sapisid);
          store.set(STORE_KEY, user);
          if (loginWindow && !loginWindow.isDestroyed()) {
            loginWindow.close();
          }
          const mainWindow = typeof getMainWindow === 'function' ? getMainWindow() : null;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('ytmusic-auth-changed', user);
          }
          resolve(user);
        }
      };

      loginWindow.webContents.on('did-navigate', (_event, url) => {
        if (url.includes('music.youtube.com')) {
          void checkAuthSuccess();
        }
      });

      loginWindow.webContents.on('did-finish-load', () => {
        void checkAuthSuccess();
      });

      loginWindow.on('closed', () => {
        loginWindow = null;
        if (!resolved) {
          resolve(null);
        }
      });
    });
  }

  /**
   * 打开 YouTube Music 登录流程（优先外部浏览器，无可用浏览器时回退到内置窗口）
   */
  function openLoginWindow() {
    const browserPath = findChromiumBrowser();
    if (browserPath) {
      return openExternalBrowserLogin(browserPath);
    }
    return openInternalLoginWindow();
  }

  /**
   * 登出并清理分区的 Cookie 与缓存
   */
  async function logout() {
    store.delete(STORE_KEY);
    await getSession().clearStorageData({
      storages: ['cookies', 'localstorage', 'cache'],
    });
    try {
      const profileDir = path.join(app.getPath('userData'), 'ytmusic_login_browser_profile');
      if (fs.existsSync(profileDir)) {
        fs.rmSync(profileDir, { recursive: true, force: true });
      }
    } catch (_) {}
    const mainWindow = typeof getMainWindow === 'function' ? getMainWindow() : null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ytmusic-auth-changed', null);
    }
  }

  /**
   * 解析时间字符串（如 3:45 或 1:02:15）为毫秒数值
   */
  function parseDurationToMs(str) {
    if (!str || typeof str !== 'string') return 0;
    const parts = str.trim().split(':').map(Number);
    if (parts.some(isNaN)) return 0;
    if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
    if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
    return 0;
  }

  /**
   * 将 Innertube 的 musicResponsiveListItemRenderer 解析为标准歌曲数据结构
   */
  function parseMusicItem(renderer) {
    if (!renderer) return null;
    const videoId = renderer.playlistItemData?.videoId ||
      renderer.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId ||
      renderer.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.navigationEndpoint?.watchEndpoint?.videoId;
    if (!videoId) return null;

    const title = renderer.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text || 'Unknown Title';
    const subtitleRuns = renderer.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];

    const artists = [];
    let artistName = 'Unknown Artist';
    let artistId = '';
    let albumName = '';
    let albumId = '';
    let durationMs = 0;

    for (let i = 0; i < subtitleRuns.length; i++) {
      const run = subtitleRuns[i];
      const nav = run.navigationEndpoint?.browseEndpoint;
      const pageType = nav?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
      if (pageType === 'MUSIC_PAGE_TYPE_ARTIST' || (nav?.browseId && nav.browseId.startsWith('UC'))) {
        if (!artistId) {
          artistName = run.text;
          artistId = nav.browseId;
        }
        artists.push({ id: nav.browseId, name: run.text });
      } else if (pageType === 'MUSIC_PAGE_TYPE_ALBUM' || (nav?.browseId && nav.browseId.startsWith('MPREb_'))) {
        albumName = run.text;
        albumId = nav.browseId;
      } else if (run.text && run.text.includes(':')) {
        const ms = parseDurationToMs(run.text);
        if (ms > 0) durationMs = ms;
      }
    }

    if (artists.length === 0 && subtitleRuns.length > 0) {
      const nonBullet = subtitleRuns.filter(r => r.text && r.text !== ' • ' && r.text !== 'Song' && r.text !== 'Video');
      if (nonBullet.length > 0) {
        artistName = nonBullet[0].text;
        artists.push({ id: '0', name: artistName });
      }
      if (nonBullet.length > 1 && !albumName) {
        albumName = nonBullet[1].text;
      }
    }

    if (!durationMs && renderer.flexColumns) {
      for (let c = 2; c < renderer.flexColumns.length; c++) {
        const text = renderer.flexColumns[c]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text;
        if (text && text.includes(':')) {
          const ms = parseDurationToMs(text);
          if (ms > 0) {
            durationMs = ms;
            break;
          }
        }
      }
    }

    if (!durationMs && renderer.fixedColumns) {
      for (const fc of renderer.fixedColumns) {
        const text = fc.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text;
        if (text && text.includes(':')) {
          const ms = parseDurationToMs(text);
          if (ms > 0) {
            durationMs = ms;
            break;
          }
        }
      }
    }

    const thumbnails = renderer.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
    const coverUrl = thumbnails.length > 0 ? thumbnails[thumbnails.length - 1].url : undefined;

    return {
      id: videoId,
      name: title,
      artist: artistName,
      artists: artists.length > 0 ? artists : [{ id: artistId || '0', name: artistName }],
      album: { id: albumId, name: albumName || 'Unknown Album', coverUrl },
      durationMs,
      coverUrl,
    };
  }

  /**
   * 代理发送已认证的 YouTube Music Innertube API 请求
   */
  async function request(endpoint, body = {}) {
    const cookies = await getPartitionCookies();
    const sapisid = extractSapisid(cookies);
    const headers = buildInnertubeHeaders(cookies, sapisid);

    const payload = {
      context: {
        client: {
          clientName: 'WEB_REMIX',
          clientVersion: '1.20240101.01.00',
          hl: 'en',
          gl: 'US',
        },
      },
      ...body,
    };

    const url = endpoint.startsWith('http')
      ? endpoint
      : `${YTMUSIC_ORIGIN}/youtubei/v1/${endpoint}`;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`YouTube Music API request failed: HTTP ${res.status}`);
    }

    return res.json();
  }

  /**
   * 搜索 YouTube Music 歌曲与视频曲目
   */
  async function searchSongs(query, limit = 20, offset = 0) {
    try {
      // 传入 params: 'EgWKAQIIAWoKEAkQChAFEAMQBA%3D%3D' 过滤纯歌曲结果，获取完整时长与专辑信息
      const json = await request('search', {
        query,
        params: 'EgWKAQIIAWoKEAkQChAFEAMQBA%3D%3D',
      });
      const sections = json.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
      const results = [];
      const seen = new Set();

      for (const sec of sections) {
        if (sec.musicCardShelfRenderer) {
          const card = sec.musicCardShelfRenderer;
          const videoId = card.title?.runs?.[0]?.navigationEndpoint?.watchEndpoint?.videoId;
          const title = card.title?.runs?.[0]?.text;
          if (videoId && !seen.has(videoId)) {
            seen.add(videoId);
            const subtitleRuns = card.subtitle?.runs || [];
            const artistRun = subtitleRuns.find(r => r.navigationEndpoint?.browseEndpoint?.browseId?.startsWith('UC')) || subtitleRuns[2] || subtitleRuns[0];
            const artistName = artistRun?.text || 'YouTube Music';
            const thumbnails = card.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
            const coverUrl = thumbnails.length > 0 ? thumbnails[thumbnails.length - 1].url : undefined;
            results.push({
              id: videoId,
              name: title,
              artist: artistName,
              artists: [{ id: '0', name: artistName }],
              album: { id: '', name: 'YouTube Music', coverUrl },
              durationMs: 0,
              coverUrl,
            });
          }
        }

        const items = sec.musicShelfRenderer?.contents
          || sec.itemSectionRenderer?.contents
          || [];
        for (const item of items) {
          const parsed = parseMusicItem(item.musicResponsiveListItemRenderer);
          if (parsed && !seen.has(parsed.id)) {
            seen.add(parsed.id);
            results.push(parsed);
          }
        }
      }

      // 如果歌曲过滤结果为空，回退到未过滤的综合搜索
      if (results.length === 0) {
        const fallbackJson = await request('search', { query });
        const fallbackSections = fallbackJson.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
        for (const sec of fallbackSections) {
          const items = sec.itemSectionRenderer?.contents || sec.musicShelfRenderer?.contents || [];
          for (const item of items) {
            const parsed = parseMusicItem(item.musicResponsiveListItemRenderer);
            if (parsed && !seen.has(parsed.id)) {
              seen.add(parsed.id);
              results.push(parsed);
            }
          }
        }
      }

      return {
        items: results.slice(0, limit),
        hasMore: results.length > limit,
        nextOffset: offset + limit,
      };
    } catch (err) {
      console.error('[YTMusicAuth] searchSongs failed:', err);
      return { items: [], hasMore: false, nextOffset: offset };
    }
  }

  /**
   * 通过 watch next 接口拉取单曲详情元数据
   */
  async function getSongDetail(videoId) {
    try {
      const json = await request('next', { videoId });
      const tabs = json.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs;
      const queue = tabs?.[0]?.tabRenderer?.content?.musicQueueRenderer;
      const panelItem = queue?.content?.playlistPanelRenderer?.contents?.[0]?.playlistPanelVideoRenderer;
      if (panelItem) {
        const title = panelItem.title?.runs?.[0]?.text || 'Unknown Title';
        const runs = panelItem.longBylineText?.runs || [];
        const artistName = runs[0]?.text || 'Unknown Artist';
        const durationMs = parseDurationToMs(panelItem.lengthText?.runs?.[0]?.text);
        const coverUrl = panelItem.thumbnail?.thumbnails?.slice(-1)?.[0]?.url;
        return {
          id: videoId,
          name: title,
          artist: artistName,
          artists: [{ id: '0', name: artistName }],
          album: { id: '', name: 'YouTube Music', coverUrl },
          durationMs,
          coverUrl,
        };
      }
    } catch (err) {
      console.warn('[YTMusicAuth] getSongDetail failed:', err);
    }
    return null;
  }

  /**
   * 利用静音后台窗口获取带有有效 PO Token 与签名的音频流直链
   */
  async function getAudioStreamUrl(videoId) {
    if (!videoId) return null;
    const cached = audioCache.get(videoId);
    if (cached && cached.expiresAt > Date.now() + 60000) {
      return cached;
    }

    return new Promise((resolve) => {
      let win = null;
      let timer = null;

      const cleanup = () => {
        if (win) {
          pendingResolvers.delete(win.webContents.id);
          try {
            if (!win.isDestroyed()) win.destroy();
          } catch (_) {}
          win = null;
        }
      };

      try {
        win = new BrowserWindow({
          show: false,
          width: 320,
          height: 240,
          webPreferences: {
            partition: PARTITION,
            autoplayPolicy: 'no-user-gesture-required',
            backgroundThrottling: false,
            nodeIntegration: false,
            contextIsolation: true,
          },
        });

        win.webContents.setAudioMuted(true);

        timer = setTimeout(() => {
          cleanup();
          console.warn(`[YTMusicAuth] Stream capture timed out for videoId: ${videoId}`);
          resolve(null);
        }, 12000);

        pendingResolvers.set(win.webContents.id, {
          resolve,
          timer,
          videoId,
          win,
        });

        win.loadURL(`https://music.youtube.com/watch?v=${videoId}`);
      } catch (err) {
        console.error('[YTMusicAuth] Error creating stream extractor window:', err);
        cleanup();
        resolve(null);
      }
    });
  }

  /**
   * 清理 YouTube 标题中的视频杂质（例如 "Official Music Video", "[MV]" 等）
   */
  function cleanTitleForLyricSearch(title) {
    if (!title || typeof title !== 'string') return '';
    return title
      .replace(/\s*[\(\[](?:(?:official\s*)?(?:music\s*)?(?:video|audio|lyrics?|visualizer|mv)|remastered|hd|4k)[^\)\]]*[\)\]]/gi, '')
      .replace(/\s*-\s*(?:official\s*(?:music\s*)?(?:video|audio)|visualizer|lyrics?|mv)$/gi, '')
      .trim();
  }

  /**
   * 从 LRCLIB 获取标准精准同步歌词（包含毫秒时间戳）
   */
  async function fetchLrclibLyrics(rawTitle, rawArtist, durationSec) {
    if (!rawTitle) return null;
    const cleanTitle = cleanTitleForLyricSearch(rawTitle);
    const cleanArtist = rawArtist && rawArtist !== 'Unknown Artist' ? rawArtist : '';

    // 1. 优先尝试精准匹配
    const titlesToTry = cleanTitle && cleanTitle !== rawTitle ? [cleanTitle, rawTitle] : [rawTitle];
    for (const title of titlesToTry) {
      try {
        let getUrl = `https://lrclib.net/api/get?track_name=${encodeURIComponent(title)}`;
        if (cleanArtist) getUrl += `&artist_name=${encodeURIComponent(cleanArtist)}`;
        if (durationSec && durationSec > 0) getUrl += `&duration=${Math.round(durationSec)}`;

        const res = await net.fetch(getUrl, {
          headers: { 'User-Agent': 'Folia Music Player (https://github.com/xianxianren/folia-ytmusic)' }
        });
        if (res.ok) {
          const data = await res.json();
          if (data.syncedLyrics && data.syncedLyrics.includes('[')) {
            return data.syncedLyrics;
          }
        }
      } catch (_) {}
    }

    // 2. 尝试全文搜索最佳匹配
    try {
      const query = cleanArtist ? `${cleanTitle || rawTitle} ${cleanArtist}` : (cleanTitle || rawTitle);
      const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`;
      const res = await net.fetch(searchUrl, {
        headers: { 'User-Agent': 'Folia Music Player (https://github.com/xianxianren/folia-ytmusic)' }
      });
      if (res.ok) {
        const items = await res.json();
        if (Array.isArray(items) && items.length > 0) {
          const syncedItems = items.filter(i => Boolean(i.syncedLyrics && i.syncedLyrics.includes('[')));
          if (syncedItems.length > 0) {
            if (durationSec && durationSec > 0) {
              syncedItems.sort((a, b) => Math.abs(a.duration - durationSec) - Math.abs(b.duration - durationSec));
            }
            return syncedItems[0].syncedLyrics;
          }
        }
      }
    } catch (_) {}

    return null;
  }

  /**
   * 拉取歌曲歌词（优先匹配 LRCLIB 精准时序同步歌词，其次回退至 YouTube Music 原生纯文本歌词）
   */
  async function getLyrics(videoId, title = '', artist = '', durationSec = 0) {
    // 1. 优先从 LRCLIB 获取带精准时间戳的同步歌词
    if (title) {
      try {
        const synced = await fetchLrclibLyrics(title, artist, durationSec);
        if (synced) {
          return synced;
        }
      } catch (err) {
        console.warn('[YTMusicAuth] fetchLrclibLyrics failed:', err);
      }
    }

    // 2. 如果未匹配到精准时序歌词，拉取 YouTube Music 自带的原生歌词
    try {
      const nextData = await request('next', { videoId });
      const tabs = nextData.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs;
      const lyricsTab = tabs?.find(t => t.tabRenderer?.title === 'Lyrics' || t.tabRenderer?.endpoint?.browseEndpoint?.browseId?.startsWith('MPLYt_'));
      const browseId = lyricsTab?.tabRenderer?.endpoint?.browseEndpoint?.browseId;
      if (browseId) {
        const browseData = await request('browse', { browseId });
        const descShelf = browseData.contents?.sectionListRenderer?.contents?.[0]?.musicDescriptionShelfRenderer;
        const lyricsText = descShelf?.description?.runs?.map(r => r.text).join('') || '';
        if (lyricsText && !lyricsText.includes('Lyrics not available')) {
          return lyricsText;
        }
      }
    } catch (err) {
      console.warn('[YTMusicAuth] getLyrics failed:', err);
    }
    return null;
  }

  /**
   * 拉取当前登录用户的收藏歌单列表
   */
  async function getUserPlaylists(limit = 20, offset = 0) {
    try {
      const data = await request('browse', { browseId: 'FEmusic_liked_playlists' });
      const twoCol = data.contents?.twoColumnBrowseResultsRenderer;
      const singleCol = data.contents?.singleColumnBrowseResultsRenderer;
      const sections = twoCol?.secondaryContents?.sectionListRenderer?.contents
        || twoCol?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents
        || singleCol?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents
        || [];
      const items = [];
      for (const sec of sections) {
        const shelf = sec.musicShelfRenderer || sec.musicCarouselShelfRenderer;
        const gridItems = shelf?.contents || sec.gridRenderer?.items || [];
        for (const item of gridItems) {
          const r = item.musicTwoRowItemRenderer;
          if (!r) continue;
          const browseId = r.navigationEndpoint?.browseEndpoint?.browseId;
          const title = r.title?.runs?.[0]?.text;
          const thumbnails = r.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
          const coverUrl = thumbnails.slice(-1)?.[0]?.url;
          if (browseId && title) {
            items.push({
              id: browseId,
              name: title,
              coverUrl,
              type: 'playlist',
            });
          }
        }
      }
      return {
        items: items.slice(0, limit),
        hasMore: items.length > limit,
        nextOffset: offset + limit,
      };
    } catch (err) {
      console.warn('[YTMusicAuth] getUserPlaylists failed:', err);
      return { items: [], hasMore: false, nextOffset: offset };
    }
  }

  /**
   * 获取歌单包含的曲目列表（支持双栏两栏与单栏布局，自动规整 VL 前缀）
   */
  async function getPlaylistTracks(browseId, limit = 50, offset = 0) {
    try {
      const normalizedBrowseId = (browseId.startsWith('PL') || browseId.startsWith('RDCL') || browseId.startsWith('OLAK'))
        ? `VL${browseId}`
        : browseId;
      const data = await request('browse', { browseId: normalizedBrowseId });
      const twoCol = data.contents?.twoColumnBrowseResultsRenderer;
      const singleCol = data.contents?.singleColumnBrowseResultsRenderer;
      const sections = twoCol?.secondaryContents?.sectionListRenderer?.contents
        || twoCol?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents
        || singleCol?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents
        || [];

      let rawItems = [];
      for (const sec of sections) {
        const shelf = sec.musicPlaylistShelfRenderer || sec.musicShelfRenderer;
        if (shelf?.contents) {
          rawItems = shelf.contents;
          break;
        }
      }

      const tracks = [];
      for (const item of rawItems) {
        const parsed = parseMusicItem(item.musicResponsiveListItemRenderer);
        if (parsed) tracks.push(parsed);
      }
      return {
        items: tracks.slice(0, limit),
        hasMore: tracks.length > limit,
        nextOffset: offset + limit,
      };
    } catch (err) {
      console.warn('[YTMusicAuth] getPlaylistTracks failed:', err);
      return { items: [], hasMore: false, nextOffset: offset };
    }
  }

  /**
   * 获取歌单或专辑的基本详情与封面
   */
  async function getCollectionDetail(browseId, type = 'playlist') {
    try {
      const normalizedBrowseId = (browseId.startsWith('PL') || browseId.startsWith('RDCL') || browseId.startsWith('OLAK'))
        ? `VL${browseId}`
        : browseId;
      const data = await request('browse', { browseId: normalizedBrowseId });
      const twoCol = data.contents?.twoColumnBrowseResultsRenderer;
      const singleCol = data.contents?.singleColumnBrowseResultsRenderer;
      const headerSection = twoCol?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]?.musicResponsiveHeaderRenderer
        || singleCol?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]?.musicResponsiveHeaderRenderer
        || data.header?.musicDetailHeaderRenderer
        || data.header?.musicEditablePlaylistDetailHeaderRenderer?.header?.musicDetailHeaderRenderer;

      const title = headerSection?.title?.runs?.[0]?.text
        || (type === 'album' ? 'YouTube Music Album' : 'YouTube Music Playlist');
      const thumbnails = headerSection?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails
        || headerSection?.thumbnail?.croppedMusicThumbnailRenderer?.thumbnail?.thumbnails
        || [];
      const coverUrl = thumbnails.length > 0 ? thumbnails[thumbnails.length - 1].url : undefined;
      const desc = headerSection?.description?.musicDescriptionShelfRenderer?.description?.runs?.map(r => r.text).join('') || '';

      return {
        providerId: 'ytmusic',
        id: browseId,
        name: title,
        type,
        coverUrl,
        description: desc,
      };
    } catch (err) {
      console.warn('[YTMusicAuth] getCollectionDetail failed:', err);
      return {
        providerId: 'ytmusic',
        id: String(browseId),
        name: type === 'album' ? 'YouTube Music Album' : 'YouTube Music Playlist',
        type,
      };
    }
  }

  /**
   * 获取艺人主页基本详情
   */
  async function getArtistDetail(browseId) {
    try {
      const data = await request('browse', { browseId });
      const header = data.header?.musicImmersiveHeaderRenderer || data.header?.musicVisualHeaderRenderer;
      const name = header?.title?.runs?.[0]?.text || 'Artist';
      const thumbnails = header?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
      const coverUrl = thumbnails.slice(-1)?.[0]?.url;
      return {
        id: browseId,
        name,
        coverUrl,
        type: 'artist',
      };
    } catch (err) {
      console.warn('[YTMusicAuth] getArtistDetail failed:', err);
      return null;
    }
  }

  /**
   * 获取艺人主页的专辑与 EP 列表
   */
  async function getArtistAlbums(artistId, limit = 20, offset = 0) {
    try {
      const data = await request('browse', { browseId: artistId });
      const contents = data.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
      const albums = [];
      for (const sec of contents) {
        const c = sec.musicCarouselShelfRenderer;
        const headerTitle = c?.header?.musicCarouselShelfBasicHeaderRenderer?.title?.runs?.[0]?.text?.toLowerCase() || '';
        if (headerTitle.includes('album') || headerTitle.includes('single') || headerTitle.includes('ep')) {
          for (const item of c.contents || []) {
            const r = item.musicTwoRowItemRenderer;
            const browseId = r?.navigationEndpoint?.browseEndpoint?.browseId;
            const title = r?.title?.runs?.[0]?.text;
            const thumbs = r?.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
            const coverUrl = thumbs[thumbs.length - 1]?.url;
            if (browseId && title) {
              albums.push({
                providerId: 'ytmusic',
                id: browseId,
                name: title,
                type: 'album',
                coverUrl,
              });
            }
          }
        }
      }
      return {
        items: albums.slice(0, limit),
        hasMore: albums.length > limit,
        nextOffset: offset + limit,
      };
    } catch (err) {
      console.warn('[YTMusicAuth] getArtistAlbums failed:', err);
      return { items: [], hasMore: false, nextOffset: offset };
    }
  }

  return {
    openLoginWindow,
    getAuth,
    logout,
    request,
    getPartitionCookies,
    searchSongs,
    getSongDetail,
    getAudioStreamUrl,
    getLyrics,
    getUserPlaylists,
    getPlaylistTracks,
    getCollectionDetail,
    getArtistDetail,
    getArtistAlbums,
  };
}

module.exports = {
  createYtmusicAuth,
};
