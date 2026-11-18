import { test, expect, lendMedia, TICKS } from './fixtures.mjs'

for (const command of ['captions.import', 'file.import']) {
  test(`F61 ${command} into an empty project imports Unicode multiline cues and its automatic sequence as one undoable operation`, async ({ film }) => {
    await film.open()
    await lendMedia(film, 'captions/dialogue.srt', Buffer.from('\uFEFF1\r\n00:00:00,000 --> 00:00:01,001\r\n你好，世界\r\nSecond line & more\r\n\r\n2\r\n00:00:02,002 --> 00:00:03,003\r\n終わり — café\r\n'))
    await film.command('file.newProject', { name: 'Empty caption project' })
    expect((await film.details()).sequence).toBeNull()
    const before = await film.command('project.items'), history = await film.history()
    const path = '../captions/dialogue.srt'
    await film.command(command, command === 'file.import' ? { paths: [path] } : { path })
    const tracks = (await film.command('captions.list')).tracks
    expect(tracks).toHaveLength(1)
    expect(tracks[0].captions.map(cue => cue.text)).toEqual(['你好，世界\nSecond line & more', '終わり — café'])
    expect(tracks[0].captions.map(cue => [cue.start, cue.end - cue.start])).toEqual([[0, TICKS * 1001 / 1000], [TICKS * 2002 / 1000, TICKS * 1001 / 1000]])
    expect((await film.history()).undo).toHaveLength(history.undo.length + 1)
    await film.undo()
    await expect.poll(async () => (await film.details()).sequence).toBeNull()
    expect(await film.command('project.items')).toEqual(before)
    await film.redo()
    await expect.poll(async () => (await film.command('captions.list')).tracks).toEqual(tracks)
    await film.saveReopen()
    expect((await film.command('captions.list')).tracks).toEqual(tracks)
  })
}
