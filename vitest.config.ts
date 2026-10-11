import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';
import { commandPinyinPlugin } from './dev/pinyin/commandPinyinPlugin.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // 命令面板的检索索引在单测里也要读到构建期生成的拼音字典。
  plugins: [commandPinyinPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  test: {
    environment: 'node',
    // 第二消费者始终参与单测；test.env 与 vi.stubEnv 使用同一入口，可覆写验证关闭/生产边界。
    // 初始选择钉在 grid：现有用例都假设没选过 suite 的人看到网格（开发阶段的初始选择是 bravais）。
    env: { VITE_LIBRARY_TUI: 'true', VITE_LIBRARY_INITIAL_SUITE: 'grid' },
    include: ['test/unit/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'test/unit/electron/bodianApiBridge.test.ts',
      'test/unit/electron/kugouApiBridge.test.ts',
      'test/unit/electron/loginBackendIpc.test.ts',
      'test/unit/electron/loginSelfCheck.test.ts',
      'test/unit/electron/netease*.test.ts',
      'test/unit/electron/networkRecorder.test.ts',
      'test/unit/electron/qq*.test.ts',
      'test/unit/hooks/useBodian*.test.ts',
      'test/unit/hooks/useKugou*.test.ts',
      'test/unit/hooks/useQq*.test.ts',
      'test/unit/onlineMusic/bodian*.test.ts',
      'test/unit/onlineMusic/kugou*.test.ts',
      'test/unit/onlineMusic/netease*.test.ts',
      'test/unit/onlineMusic/qq*.test.ts',
      'test/unit/onlineMusic/login*.test.ts',
      'test/unit/onlineMusic/qrLoginDiagnosticReport.test.ts',
      'test/unit/services/netease*.test.ts',
      'test/unit/services/localMusicLyricsMatch.test.ts',
      'test/unit/lyrics/bodianLyrics.test.ts',
      'test/unit/lyrics/autoMatchBestLyric.test.ts',
      'test/unit/lyrics/architecture.test.ts',
      'test/unit/gridView/bodian*.test.ts',
      'test/unit/gridView/gridViewContextActions.test.ts',
      'test/unit/localLibrary/onlineMetadataSearchService.test.ts',
      'test/unit/worker/qqQrChannel.test.ts',
      'test/unit/search/searchCollectionAdapters.test.ts',
      'test/unit/search/searchNavigationStore.test.ts',
      'test/unit/search/searchTrackActions.test.ts',
      'test/unit/navigation/qrLoginFailureHelpPresentation.test.ts',
      'test/unit/onlineMusic/omni.test.ts',
      'test/unit/stores/onlineProviderAccountStore.test.ts'
    ]
  }
});
