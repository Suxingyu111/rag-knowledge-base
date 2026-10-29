import type { ThemeConfig } from 'antd'

/**
 * 全站 Ant Design 主题。
 *
 * 在 `main.tsx` 中交给唯一的 `<ConfigProvider>`，页面与布局不再各自
 * 包一层 Provider，保证弹层、message 与业务组件共用同一份令牌。
 *
 * 色板与 `layouts/BasicLayout.css` 中的 `--kb-*` 变量保持一致：
 * 主色 `#b6441d`、纸色背景 `#f3efe5`、卡片背景 `#fbf8f0`。
 */
export const APP_THEME: ThemeConfig = {
  token: {
    colorPrimary: '#b6441d',
    colorInfo: '#b6441d',
    colorText: '#1a261f',
    colorTextSecondary: '#73786f',
    colorBgBase: '#f3efe5',
    colorBgContainer: '#fbf8f0',
    colorBorder: '#ddd5c4',
    colorBorderSecondary: '#e9e2d4',
    borderRadius: 12,
    controlHeight: 40,
    fontFamily:
      "'Avenir Next', 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans SC', 'Helvetica Neue', sans-serif",
  },
  components: {
    Button: {
      fontWeight: 600,
      primaryShadow: 'none',
    },
    Input: {
      activeBorderColor: '#d65c31',
      hoverBorderColor: '#c9c0ac',
    },
    Menu: {
      darkItemBg: 'transparent',
      darkSubMenuItemBg: 'transparent',
      darkItemColor: 'rgba(243, 238, 226, 0.62)',
      darkItemHoverColor: '#f3eee2',
      darkItemHoverBg: 'rgba(243, 238, 226, 0.06)',
      darkItemSelectedColor: '#18231c',
      darkItemSelectedBg: '#f2ecdd',
      darkItemDisabledColor: 'rgba(243, 238, 226, 0.28)',
      darkGroupTitleColor: 'rgba(243, 238, 226, 0.36)',
      itemBorderRadius: 10,
      itemHeight: 44,
      itemMarginInline: 0,
      itemPaddingInline: 14,
      groupTitleFontSize: 10,
      iconSize: 17,
    },
  },
}
