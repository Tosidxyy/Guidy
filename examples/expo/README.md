# Expo branding 接入示例（非独立工程）

这是 **Guidy** 的图标与启动页配置范例，没有 Expo 工程源码或 `package.json`，不能直接执行 `npm start`。

1. 先在仓库根目录初始化 `apps/mobile`：`npx create-expo-app@latest apps/mobile`。
2. 将 `examples/expo/assets/images/icon.png`、`splash-icon.png` 复制到 `apps/mobile/assets/images/`。
3. **合并** `examples/expo/app.json` 中的 `name` / `slug` / `icon` / `plugins` 等相关字段到实际应用的配置，保留 Expo 自动生成的其他字段，不要直接覆盖。当前 Expo SDK 如已自动配置 `expo-splash-screen` 插件，请合并设置并避免重复插件。
4. 需要唯一 `ios.bundleIdentifier` 时由开发者根据自己的 Apple 账户和应用 ID 决定，不使用示例值假冒已登记 ID。
5. 图标是黑色全出血方形 RGB PNG（1024×1024），不提前裁圆角；iOS 负责圆角裁切。白色原图四周的留白只出现在设计母版中，不应直接拿作 `expo.icon`。
6. 重新构建 iPhone 应用验证启动屏幕与图标；`Expo Go` 显示的是 Expo Go 本身的 App Icon，不代表最终安装包图标。

主品牌源图：`../../assets/icons/guidy-approved-original.png`，与用户最终选定的图形**完全一致**；不得让 Codex 重新设计形状、换蓝色或替换卡通向导。
