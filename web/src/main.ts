import { installConsoleBuffer } from './console-buffer.js';

// Capture console output + uncaught errors into a ring buffer so the player's
// Report button can ship them back to the server. Run this BEFORE any
// component code so we don't miss early-startup messages.
installConsoleBuffer();

// Importing the components registers their custom elements as a side effect.
import './components/app-shell.js';
import './components/share-banner.js';
import './components/reconnect-overlay.js';
import './components/home-view.js';
import './components/home-header.js';
import './components/poster-strip.js';
import './components/season-strip.js';
import './components/watched-button.js';
import './components/series-detail.js';
import './components/media-player.js';
import './components/settings-view.js';
import './components/tile.js';
