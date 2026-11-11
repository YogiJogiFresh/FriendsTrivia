import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GifPicker } from '../components/host/GifPicker'
import { freeTextConfigForSave } from './freeTextEditor'

describe('pack editor answers', () => {
  it('preserves accepted-answer draft whitespace and cleans it only in the save payload', () => {
    const text = 'Dancing Queen \n\n  Another song\n'
    const config = { correctAnswer: 'Main answer', acceptedAnswers: text.split('\n') }
    expect(freeTextConfigForSave(config)).toEqual({
      correctAnswer: 'Main answer', acceptedAnswers: ['Dancing Queen', 'Another song'],
    })
    expect(config.acceptedAnswers.join('\n')).toBe(text)
    expect(freeTextConfigForSave({ correctAnswer: 'Only answer' })).toEqual({
      correctAnswer: 'Only answer', acceptedAnswers: [],
    })
  })

  it('defaults the answer GIF picker to direct URL while retaining provider choices', () => {
    const html = renderToStaticMarkup(
      <GifPicker providers={{ giphy: false, tenor: false }}
        onProvidersChange={() => {}} onChange={() => {}} />,
    )
    expect(html).toContain('<option value="url" selected="">Direct URL</option>')
    expect(html).toContain('aria-label="Direct GIF URL"')
    expect(html).toContain('<option value="giphy">GIPHY</option>')
    expect(html).toContain('<option value="tenor">Tenor</option>')
  })
})
