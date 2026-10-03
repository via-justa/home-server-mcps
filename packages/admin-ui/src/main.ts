import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import { createAppRouter } from './router';
import { applyTheme, getTheme } from './theme';
import './styles.css';

applyTheme(getTheme());
createApp(App).use(createPinia()).use(createAppRouter()).mount('#app');
