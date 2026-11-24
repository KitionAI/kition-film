/** The development host (dev.html): opens `public/sample/films/Sample.kfilm` in the workspace folder `films`, lending the workspace (with `clips/bars.mp4`) for its media. */
import { startDevHost } from '@kition/sdk/dev-host'

startDevHost({ sample: './sample/films/Sample.kfilm', folder: 'films', lend: true, viewState: true, pickable: /\.(mp4|mov|wav|mp3|png|jpe?g)$/i, files: { 'clips/bars.mp4': './sample/clips/bars.mp4' } })
