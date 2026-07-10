import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PLACEHOLDERS, render, tokensIn } from '../../installer/lib/placeholders.mjs'

test('render substitutes registered tokens and leaves unknown ones intact', () => {
  const out = render('# {{PROJECT_NAME}} by {{GITHUB_OWNER}} — {{NOT_A_TOKEN}}', {
    PROJECT_NAME: 'Acme',
    GITHUB_OWNER: 'acme-co',
  })
  assert.equal(out, '# Acme by acme-co — {{NOT_A_TOKEN}}')
})

test('render does not touch GitHub Actions ${{ }} expressions', () => {
  const yaml = 'run: echo ${{ secrets.GITHUB_TOKEN }} ${{ github.ref }}'
  assert.equal(render(yaml, { PROJECT_NAME: 'x' }), yaml)
})

test('tokensIn finds all distinct tokens', () => {
  assert.deepEqual([...tokensIn('{{A_1}} {{A_1}} {{B_2}}')], ['A_1', 'B_2'])
})

test('PROJECT_SLUG default kebab-cases the project name', () => {
  const ctx = { dirName: 'ignored', answers: { PROJECT_NAME: 'Acme  Portal!' } }
  assert.equal(PLACEHOLDERS.PROJECT_SLUG.default(ctx), 'acme-portal')
})

test('SECURITY_OWNERS defaults to @GITHUB_OWNER', () => {
  const ctx = { answers: { GITHUB_OWNER: 'acme-co' } }
  assert.equal(PLACEHOLDERS.SECURITY_OWNERS.default(ctx), '@acme-co')
})

test('PRODUCT_IDENTIFIER derives reverse-DNS from slug and never exceeds 30 chars', () => {
  const ctx = { answers: { PROJECT_SLUG: 'acme-curriculum' } }
  assert.equal(PLACEHOLDERS.PRODUCT_IDENTIFIER.default(ctx), 'com.example.acmecurriculum')
  const long = { answers: { PROJECT_SLUG: 'a-very-long-project-slug-that-overflows' } }
  assert.ok(PLACEHOLDERS.PRODUCT_IDENTIFIER.default(long).length <= 30)
})

test('DB_NAME default converts kebab slug to snake_case', () => {
  const ctx = { answers: { PROJECT_SLUG: 'acme-curriculum' } }
  assert.equal(PLACEHOLDERS.DB_NAME.default(ctx), 'acme_curriculum')
})

test('API_ORIGIN defaults to local loopback for bootstrap-green', () => {
  assert.equal(PLACEHOLDERS.API_ORIGIN.default({}), 'http://127.0.0.1:8787')
})
