/** The development host (dev.html): opens `public/sample/films/Sample.kfilm`, lending `public/sample/` for its media. */
import { startDevHost } from '@kition/kit-dev-host'

startDevHost({ sample: './sample/films/Sample.kfilm', lend: { root: './sample/', folder: 'films' }, pickable: /\.(mp4|mov|wav|mp3|png|jpe?g)$/i, files: { 'clips/bars.mp4': './sample/clips/bars.mp4' } })
