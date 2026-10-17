// 与上游 folia-major postcss.config.js 同构：Tailwind v4 经 postcss 进入 Vite 构建。
// 仅 src/folia-tailwind.css 引入 tailwind 层；其余 CSS 只过 autoprefixer（无行为变化）。
export default {
  plugins: {
    '@tailwindcss/postcss': {},
    autoprefixer: {},
  },
};
