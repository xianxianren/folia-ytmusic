import React, { useState } from 'react';
import { ExternalLink, Loader2, Music2, RotateCcw, X, AlertTriangle } from 'lucide-react';
import { motion } from 'framer-motion';
import { useOnlineProviderAccountStore } from '../../../../stores/useOnlineProviderAccountStore';

// src/library/suites/grid/account/OnlineProviderLoginModal.tsx
// YouTube Music 登录弹窗：触发 Electron 嵌入式 BrowserWindow 进行 Google/YouTube 登录并捕获认证 Cookie。

export type OnlineProviderLoginModalProps = {
    title?: string;
    note?: string;
    qrCodeImg?: string;
    statusText?: string;
    state?: 'idle' | 'loading' | 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'error';
    retryLabel?: string;
    closeLabel?: string;
    retryDisabled?: boolean;
    loginMethods?: unknown;
    backendFailure?: unknown;
    failureHelp?: unknown;
    onRetry?: () => void;
    onClose: () => void;
};

/**
 * YouTube Music 登录弹窗组件
 */
const OnlineProviderLoginModal: React.FC<OnlineProviderLoginModalProps> = ({
    title = 'Sign in to YouTube Music',
    note,
    closeLabel = 'Close',
    onClose,
}) => {
    const [isLoggingIn, setIsLoggingIn] = useState(false);
    const [loginError, setLoginError] = useState<string | null>(null);

    /**
     * 调起 Electron 独立窗口打开 Google 登录页
     */
    const handleOpenBrowserLogin = async () => {
        if (!window.electron?.openYtmusicLogin) {
            setLoginError('Desktop app runtime required for YouTube Music login');
            return;
        }

        setIsLoggingIn(true);
        setLoginError(null);

        try {
            const user = await window.electron.openYtmusicLogin();
            if (user) {
                useOnlineProviderAccountStore.getState().updateAccount('ytmusic', {
                    status: 'authenticated',
                    user,
                    freshness: 'fresh',
                });
                onClose();
            }
        } catch (err: any) {
            setLoginError(err?.message || 'Failed to complete login');
        } finally {
            setIsLoggingIn(false);
        }
    };

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="absolute inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-xl p-4"
            role="dialog"
            aria-modal="true"
            aria-label={title}
        >
            <motion.div
                initial={{ scale: 0.92, opacity: 0, y: 24 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.92, opacity: 0, y: 12 }}
                transition={{ type: 'spring', bounce: 0, duration: 0.5 }}
                className="bg-zinc-900/95 border border-white/10 p-8 rounded-3xl w-full max-w-sm overflow-hidden text-center relative shadow-2xl"
            >
                <button
                    type="button"
                    onClick={onClose}
                    aria-label={closeLabel}
                    className="absolute top-4 right-4 opacity-40 hover:opacity-100 rounded-full bg-white/5 p-1 transition-colors cursor-pointer"
                    style={{ color: 'var(--text-primary)' }}
                >
                    <X size={16} />
                </button>

                {/* YouTube Music 品牌徽标 */}
                <div className="flex justify-center mb-4">
                    <div className="w-16 h-16 rounded-2xl bg-red-600/10 border border-red-500/20 flex items-center justify-center shadow-inner">
                        <div className="w-10 h-10 rounded-full bg-red-600 flex items-center justify-center text-white shadow-lg">
                            <Music2 size={22} className="text-white" />
                        </div>
                    </div>
                </div>

                <h3 className="text-lg font-bold mb-2" style={{ color: 'var(--text-primary)' }}>
                    {title}
                </h3>

                <p className="text-xs opacity-60 mb-6 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                    Sign in with your Google account to access your library, playlists, subscriptions, and high-fidelity audio streams.
                </p>

                {loginError && (
                    <div className="mb-5 p-3 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center gap-2 text-left">
                        <AlertTriangle size={16} className="text-red-400 shrink-0" />
                        <span className="text-xs text-red-300 break-words">{loginError}</span>
                    </div>
                )}

                {/* 主操作区 */}
                <div className="flex flex-col items-center gap-3">
                    <button
                        type="button"
                        onClick={handleOpenBrowserLogin}
                        disabled={isLoggingIn}
                        className="w-full flex items-center justify-center gap-2.5 py-3.5 px-4 rounded-2xl bg-red-600 hover:bg-red-500 active:scale-[0.98] text-white font-semibold text-xs transition-all shadow-lg shadow-red-600/25 cursor-pointer disabled:opacity-60 disabled:cursor-wait"
                    >
                        {isLoggingIn ? (
                            <>
                                <Loader2 size={16} className="animate-spin" />
                                <span>Waiting for login window...</span>
                            </>
                        ) : (
                            <>
                                <ExternalLink size={16} />
                                <span>Sign in with Google</span>
                            </>
                        )}
                    </button>

                    {isLoggingIn && (
                        <p className="text-[11px] opacity-40 animate-pulse mt-1" style={{ color: 'var(--text-secondary)' }}>
                            Complete the sign-in inside the opened window.
                        </p>
                    )}

                    {loginError && !isLoggingIn && (
                        <button
                            type="button"
                            onClick={handleOpenBrowserLogin}
                            className="inline-flex items-center gap-1.5 mt-2 px-4 py-2 rounded-full bg-white/10 hover:bg-white/15 text-xs font-semibold transition-colors text-white/80"
                        >
                            <RotateCcw size={13} />
                            <span>Retry</span>
                        </button>
                    )}
                </div>

                {note && (
                    <p className="text-[10px] opacity-30 mt-6" style={{ color: 'var(--text-secondary)' }}>
                        {note}
                    </p>
                )}
            </motion.div>
        </motion.div>
    );
};

export default OnlineProviderLoginModal;
