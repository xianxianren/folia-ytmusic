import type { SongResult, UnifiedSong } from '../../types';
import type {
    AudioQualityPreference,
    MediaId,
    OnlineMusicProvider,
    ProviderAudioSource,
    ProviderCollection,
    ProviderLyricsResult,
    ProviderPage,
    ProviderSongAvailability,
    ProviderUser,
} from '../../types/onlineMusic';
import { createProviderSongMetadata } from '../../utils/songMetadata';
import { parseLyricsByFormat } from '../../utils/lyrics/parserCore';

// src/services/onlineMusic/ytmusicProvider.ts
// YouTube Music 提供方实现骨架，对接 YouTube Music 搜索、播放、歌词、认证与资料库契约。

/**
 * 规范化原始歌曲数据为播放器通用的 UnifiedSong 结构
 */
export const normalizeYtmusicSong = (raw: unknown): UnifiedSong => {
    const record = raw && typeof raw === 'object' ? (raw as Record<string, any>) : {};
    const mediaId = String(record.id || record.videoId || '');
    const artists = Array.isArray(record.artists)
        ? record.artists.map((artist: any, index: number) => ({
            id: artist?.id ?? String(index),
            name: String(artist?.name || ''),
        }))
        : [{ id: '0', name: String(record.artist || 'Unknown Artist') }];

    const album = record.album && typeof record.album === 'object'
        ? {
            id: record.album.id ?? '',
            name: String(record.album.name || 'Unknown Album'),
            coverUrl: record.album.coverUrl || record.coverUrl || record.thumbnails?.[0]?.url,
        }
        : {
            id: '',
            name: String(record.album || 'Unknown Album'),
            coverUrl: record.coverUrl || record.thumbnails?.[0]?.url,
        };

    const durationMs = Number(record.durationMs || record.duration || 0);

    return {
        id: mediaId,
        name: String(record.name || record.title || 'Unknown Title'),
        artists,
        album,
        durationMs: Number.isFinite(durationMs) ? durationMs : 0,
        isPureMusic: Boolean(record.isPureMusic),
        sourceRef: {
            kind: 'online',
            providerId: 'ytmusic',
            mediaId,
        },
    };
};

/**
 * 规范化 YouTube 账户资料
 */
const normalizeUser = (raw: unknown): ProviderUser => {
    const record = raw && typeof raw === 'object' ? (raw as Record<string, any>) : {};
    return {
        id: String(record.id || record.userId || '0'),
        nickname: String(record.nickname || record.name || 'YouTube User'),
        avatarUrl: record.avatarUrl || record.picture,
    };
};

/**
 * 规范化 YouTube 歌单/专辑集合
 */
const normalizeCollection = (raw: unknown, type = 'playlist'): ProviderCollection => {
    const record = raw && typeof raw === 'object' ? (raw as Record<string, any>) : {};
    return {
        providerId: 'ytmusic',
        id: String(record.id || record.playlistId || record.browseId || ''),
        name: String(record.name || record.title || ''),
        type,
        coverUrl: record.coverUrl || record.thumbnails?.[0]?.url,
        description: record.description,
        trackCount: typeof record.trackCount === 'number' ? record.trackCount : undefined,
    };
};

export const ytmusicProvider: OnlineMusicProvider = {
    id: 'ytmusic',
    displayName: 'YouTube Music',
    shortName: 'YTM',
    capabilities: {
        search: true,
        playback: true,
        lyrics: true,
        auth: true,
        userLibrary: true,
        playlists: true,
        albums: true,
        artists: true,
        recommendations: true,
        mutations: true,
        wordByWordLyrics: false,
    },
    normalizeSong: normalizeYtmusicSong,
    normalizeUser,
    normalizeCollection,
    songMetadata: {
        getSongMetadata: (song: SongResult) => createProviderSongMetadata(song),
    },
    getSongPageUrl(song: SongResult): string | null {
        const mediaId = song.sourceRef?.kind === 'online' ? song.sourceRef.mediaId : song.id;
        return mediaId ? `https://music.youtube.com/watch?v=${mediaId}` : null;
    },
    search: {
        async searchSongs(query: string, limit: number, offset: number): Promise<ProviderPage<UnifiedSong>> {
            if (typeof window !== 'undefined' && window.electron?.ytmusicSearch) {
                const res = await window.electron.ytmusicSearch(query, limit, offset);
                return {
                    items: (res?.items || []).map(normalizeYtmusicSong),
                    hasMore: Boolean(res?.hasMore),
                    nextOffset: res?.nextOffset ?? (offset + limit),
                };
            }
            return { items: [], hasMore: false, nextOffset: offset };
        },
    },
    playback: {
        async getSongDetail(id: MediaId): Promise<UnifiedSong | null> {
            if (typeof window !== 'undefined' && window.electron?.getYtmusicSongDetail) {
                const raw = await window.electron.getYtmusicSongDetail(String(id));
                return raw ? normalizeYtmusicSong(raw) : null;
            }
            return null;
        },
        async getAudioSource(song: SongResult, quality: AudioQualityPreference): Promise<ProviderAudioSource | null> {
            const videoId = song.sourceRef?.kind === 'online' ? song.sourceRef.mediaId : song.id;
            if (!videoId || typeof window === 'undefined' || !window.electron?.getYtmusicAudioUrl) {
                return null;
            }
            const stream = await window.electron.getYtmusicAudioUrl(String(videoId));
            if (!stream?.url) {
                return null;
            }
            let cleanUrl = stream.url;
            try {
                const u = new URL(cleanUrl);
                u.searchParams.delete('range');
                u.searchParams.delete('rn');
                u.searchParams.delete('rbuf');
                u.searchParams.delete('ump');
                u.searchParams.delete('srfvp');
                cleanUrl = u.toString();
            } catch {
                // Keep original if parsing fails
            }
            return {
                url: cleanUrl,
                fetchedAt: Date.now(),
                expiresAt: stream.expiresAt,
                quality,
            };
        },
        getAvailability(_song: SongResult): ProviderSongAvailability {
            return { state: 'playable' };
        },
    },
    lyrics: {
        async getLyrics(song: SongResult): Promise<ProviderLyricsResult> {
            const videoId = song.sourceRef?.kind === 'online' ? song.sourceRef.mediaId : song.id;
            if (!videoId || typeof window === 'undefined' || !window.electron?.getYtmusicLyrics) {
                return { lyrics: null, isPureMusic: false };
            }
            const artistName = song.artists?.[0]?.name || (song as any).artist || '';
            const durationSec = song.durationMs ? song.durationMs / 1000 : 0;
            const text = await window.electron.getYtmusicLyrics(String(videoId), song.name, artistName, durationSec);
            if (!text) {
                return { lyrics: null, isPureMusic: false };
            }
            const parsed = parseLyricsByFormat('lrc', text);
            if (parsed.lines && parsed.lines.length > 0) {
                return {
                    lyrics: parsed,
                    mainText: text,
                    isPureMusic: false,
                };
            }

            return {
                lyrics: null,
                mainText: text,
                isPureMusic: false,
            };
        },
    },
    auth: {
        async getLoginStatus(): Promise<ProviderUser | null> {
            if (typeof window !== 'undefined' && window.electron?.getYtmusicAuth) {
                const user = await window.electron.getYtmusicAuth();
                return user ? normalizeUser(user) : null;
            }
            return null;
        },
        async logout(): Promise<void> {
            if (typeof window !== 'undefined' && window.electron?.logoutYtmusic) {
                await window.electron.logoutYtmusic();
            }
        },
    },
    library: {
        async getUserPlaylists(_userId: MediaId, limit: number, offset: number): Promise<ProviderPage<ProviderCollection>> {
            if (typeof window !== 'undefined' && window.electron?.getYtmusicUserPlaylists) {
                const res = await window.electron.getYtmusicUserPlaylists(limit, offset);
                return {
                    items: (res?.items || []).map(item => normalizeCollection(item, 'playlist')),
                    hasMore: Boolean(res?.hasMore),
                    nextOffset: res?.nextOffset ?? (offset + limit),
                };
            }
            return { items: [], hasMore: false, nextOffset: offset };
        },
        async getLikedSongIds(_userId: MediaId): Promise<MediaId[]> {
            if (typeof window !== 'undefined' && window.electron?.getYtmusicPlaylistTracks) {
                const res = await window.electron.getYtmusicPlaylistTracks('VLLM', 100, 0);
                return (res?.items || []).map(item => String(item.id || item.videoId)).filter(Boolean);
            }
            return [];
        },
        async getLikedSongs(_userId: MediaId): Promise<UnifiedSong[]> {
            if (typeof window !== 'undefined' && window.electron?.getYtmusicPlaylistTracks) {
                const res = await window.electron.getYtmusicPlaylistTracks('VLLM', 100, 0);
                return (res?.items || []).map(normalizeYtmusicSong);
            }
            return [];
        },
    },
    catalog: {
        async getPlaylistTracks(id: MediaId, limit: number, offset: number): Promise<ProviderPage<UnifiedSong>> {
            if (typeof window !== 'undefined' && window.electron?.getYtmusicPlaylistTracks) {
                const res = await window.electron.getYtmusicPlaylistTracks(String(id), limit, offset);
                return {
                    items: (res?.items || []).map(normalizeYtmusicSong),
                    hasMore: Boolean(res?.hasMore),
                    nextOffset: res?.nextOffset ?? (offset + limit),
                };
            }
            return { items: [], hasMore: false, nextOffset: offset };
        },
        async getPlaylistDetail(id: MediaId): Promise<ProviderCollection | null> {
            if (typeof window !== 'undefined' && window.electron?.getYtmusicCollectionDetail) {
                const res = await window.electron.getYtmusicCollectionDetail(String(id), 'playlist');
                return res ? normalizeCollection(res, 'playlist') : null;
            }
            return {
                providerId: 'ytmusic',
                id: String(id),
                name: 'YouTube Music Playlist',
                type: 'playlist',
            };
        },
        async getAlbumTracks(id: MediaId, limit?: number, offset?: number): Promise<ProviderPage<UnifiedSong>> {
            if (typeof window !== 'undefined' && window.electron?.getYtmusicPlaylistTracks) {
                const res = await window.electron.getYtmusicPlaylistTracks(String(id), limit, offset);
                return {
                    items: (res?.items || []).map(normalizeYtmusicSong),
                    hasMore: Boolean(res?.hasMore),
                    nextOffset: res?.nextOffset ?? ((offset || 0) + (limit || 50)),
                };
            }
            return { items: [], hasMore: false, nextOffset: offset || 0 };
        },
        async getAlbumDetail(id: MediaId): Promise<ProviderCollection | null> {
            if (typeof window !== 'undefined' && window.electron?.getYtmusicCollectionDetail) {
                const res = await window.electron.getYtmusicCollectionDetail(String(id), 'album');
                return res ? normalizeCollection(res, 'album') : null;
            }
            return {
                providerId: 'ytmusic',
                id: String(id),
                name: 'YouTube Music Album',
                type: 'album',
            };
        },
        async getArtistSongs(id: MediaId, limit: number, offset: number): Promise<ProviderPage<UnifiedSong>> {
            if (typeof window !== 'undefined' && window.electron?.getYtmusicPlaylistTracks) {
                const res = await window.electron.getYtmusicPlaylistTracks(String(id), limit, offset);
                return {
                    items: (res?.items || []).map(normalizeYtmusicSong),
                    hasMore: Boolean(res?.hasMore),
                    nextOffset: res?.nextOffset ?? (offset + limit),
                };
            }
            return { items: [], hasMore: false, nextOffset: offset };
        },
        async getArtistAlbums(id: MediaId, limit: number, offset: number): Promise<ProviderPage<ProviderCollection>> {
            if (typeof window !== 'undefined' && window.electron?.getYtmusicArtistAlbums) {
                const res = await window.electron.getYtmusicArtistAlbums(String(id), limit, offset);
                return {
                    items: (res?.items || []).map(item => normalizeCollection(item, 'album')),
                    hasMore: Boolean(res?.hasMore),
                    nextOffset: res?.nextOffset ?? (offset + limit),
                };
            }
            return { items: [], hasMore: false, nextOffset: offset };
        },
        async getArtistDetail(id: MediaId): Promise<ProviderCollection | null> {
            if (typeof window !== 'undefined' && window.electron?.getYtmusicArtistDetail) {
                const res = await window.electron.getYtmusicArtistDetail(String(id));
                return res ? normalizeCollection(res, 'artist') : null;
            }
            return null;
        },
    },
    recommendations: {
        async getDailySongs(): Promise<UnifiedSong[]> {
            return [];
        },
        async getPersonalFm(): Promise<UnifiedSong[]> {
            return [];
        },
        async getRecommendedCollections(limit: number): Promise<ProviderCollection[]> {
            return [];
        },
    },
    mutations: {
        async likeSong(song, liked) {},
        async updatePlaylistTracks(operation, playlist, tracks) {},
        async subscribePlaylist(playlist, subscribed) {},
        async subscribeAlbum(id, subscribed) {},
    },
};
