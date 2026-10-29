import { createApplication } from './modules/application.mjs';
import { createBrowserEnvironment } from './modules/environment.mjs';

createApplication(createBrowserEnvironment(globalThis)).start();
