const { app, BrowserWindow, session, safeStorage } = require('electron');
const crypto = require('crypto');

// electron/ytmusicAuth.cjs
// YouTube Music 认证管理：管理嵌入式登录窗口、Cookie 提取、SAPISIDHASH 签名与 Innertube API 代理请求。

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
 * 创建 YouTube Music 认证管理控制器
 */
function createYtmusicAuth({ store, getMainWindow }) {
  let loginWindow = null;
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
          if (pending && (details.url.includes('mime=audio') || details.url.includes('audio'))) {
            pendingResolvers.delete(details.webContentsId);
            clearTimeout(pending.timer);

            try {
              const urlObj = new URL(details.url);
              urlObj.searchParams.delete('range');
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
   * 打开独立登录弹窗，并在登录成功后自动捕获 Cookie、关闭弹窗
   */
  function openLoginWindow() {
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
   * 登出并清理分区的 Cookie 与缓存
   */
  async function logout() {
    store.delete(STORE_KEY);
    await getSession().clearStorageData({
      storages: ['cookies', 'localstorage', 'cache'],
    });
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
        artistName = run.text;
        artistId = nav.browseId;
      } else if (pageType === 'MUSIC_PAGE_TYPE_ALBUM' || (nav?.browseId && nav.browseId.startsWith('MPREb_'))) {
        albumName = run.text;
        albumId = nav.browseId;
      } else if (run.text && run.text.includes(':')) {
        const ms = parseDurationToMs(run.text);
        if (ms > 0) durationMs = ms;
      }
    }

    if (artistName === 'Unknown Artist' && subtitleRuns.length > 0) {
      const nonBullet = subtitleRuns.filter(r => r.text && r.text !== ' • ' && r.text !== 'Song' && r.text !== 'Video');
      if (nonBullet.length > 0) {
        artistName = nonBullet[0].text;
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
      artists: [{ id: artistId || '0', name: artistName }],
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
      const json = await request('search', { query });
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

        const items = sec.itemSectionRenderer?.contents || sec.musicShelfRenderer?.contents || [];
        for (const item of items) {
          const parsed = parseMusicItem(item.musicResponsiveListItemRenderer);
          if (parsed && !seen.has(parsed.id)) {
            seen.add(parsed.id);
            results.push(parsed);
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
   * 拉取歌曲内嵌歌词（若存在）
   */
  async function getLyrics(videoId) {
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
      const sections = data.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
      const items = [];
      for (const sec of sections) {
        const shelf = sec.musicShelfRenderer || sec.musicCarouselShelfRenderer;
        const gridItems = shelf?.contents || [];
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
   * 获取歌单包含的曲目列表
   */
  async function getPlaylistTracks(browseId, limit = 50, offset = 0) {
    try {
      const data = await request('browse', { browseId });
      const contents = data.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
      const shelf = contents?.[0]?.musicPlaylistShelfRenderer || contents?.[0]?.musicShelfRenderer;
      const items = shelf?.contents || [];
      const tracks = [];
      for (const item of items) {
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
    getArtistDetail,
  };
}

module.exports = {
  createYtmusicAuth,
};
