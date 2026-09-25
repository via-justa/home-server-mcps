import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import { createAppRouter } from './router';
import './styles.css';

createApp(App).use(createPinia()).use(createAppRouter()).mount('#app');
