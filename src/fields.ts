/**
 * File field types (`FieldType` from `@strutvane/contracts`): `fileField`, `imageField` and
 * `filesField`. One definition answers every question the framework and UI ask about a field:
 * the column, the validator, the JSON Schema for OpenAPI and the UI widget (RFC-0002 §2).
 *
 * **What the column holds:** the id (UUID) of a row in the `files` table, or for `filesField`
 * a JSON array of ids in display order. Bytes live on a disk; the `files` row knows where.
 *
 * **What the validator accepts:**
 * - an id string: a file that is already stored (a direct upload, or keeping the current file
 *   on update). Ownership and status are checked when the file is committed, not here;
 * - an *inspected upload* (`{ size, detectedMime, width?, height? }`, the facts the framework's
 *   `UploadedFile` carries): checked against the field's rules, with one issue per bad file.
 *
 * @module
 */
import type {
  ColumnSpec,
  FieldType,
  FilterOperator,
  JsonSchema,
  SqlDialect,
  StandardSchemaV1,
  StandardSchemaV1Issue,
} from '@strutvane/framework/contracts'
import { createMessages, isUuidV7 } from '@strutvane/framework/core'
import { type FileIssue, fileIssue } from './errors.ts'
import { FILES_MESSAGES_EN } from './messages.ts'
import {
  DEFAULT_IMAGE_TYPES,
  type FileRules,
  type FilesRules,
  type ImageRules,
  type ResolvedRules,
  resolveCount,
  resolveRules,
} from './rules.ts'
import { checkFile, type FileFacts } from './validate.ts'
import type { VariantSpecs } from './variants.ts'

/** Options of `fileField`. */
export interface FileFieldOptions extends FileRules {
  /** Label used in messages (`{attribute}`). Default `"The file"`. */
  readonly label?: string
  /** Whether a value is required. Default `false`. */
  readonly required?: boolean
}

/** Options of `imageField`. */
export interface ImageFieldOptions extends FileFieldOptions {
  readonly image?: ImageRules
  /** Variants generated on the queue after upload, e.g. `{ thumb: [200, 200] }`. */
  readonly variants?: VariantSpecs
}

/** Options of `filesField`. */
export interface FilesFieldOptions extends FilesRules {
  readonly label?: string
  readonly required?: boolean
}

/** A value of a single-file field: a stored file id, or an inspected upload to validate. */
export type FileValue = string | FileFacts

/** A standard-schema issue that also carries the stable code and params (RFC-0003). */
export interface FileSchemaIssue extends StandardSchemaV1Issue {
  readonly code: string
  readonly params?: Readonly<Record<string, string | number | boolean>>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Whether a string looks like a file id (any UUID version; v7 is what this package creates). */
export function isFileId(value: unknown): value is string {
  return typeof value === 'string' && (UUID.test(value) || isUuidV7(value))
}

function isFacts(value: unknown): value is FileFacts {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v['size'] === 'number' &&
    Number.isFinite(v['size']) &&
    typeof v['detectedMime'] === 'string' &&
    (v['width'] === undefined || typeof v['width'] === 'number') &&
    (v['height'] === undefined || typeof v['height'] === 'number')
  )
}

const messages = createMessages({ package: [FILES_MESSAGES_EN] })

function toSchemaIssue(
  issue:
    | FileIssue
    | {
        code: string
        path: readonly (string | number)[]
        params?: Readonly<Record<string, string | number | boolean>>
      },
  label: string,
): FileSchemaIssue {
  const params = issue.params ?? {}
  return {
    code: issue.code,
    path: issue.path,
    ...(issue.params ? { params: issue.params } : {}),
    // Rendered from the catalog as a fallback; the framework re-renders by code and locale.
    message: messages.format(`validation.${issue.code}`, { attribute: label, ...params }),
  }
}

function single(
  value: unknown,
  rules: ResolvedRules,
  path: readonly (string | number)[],
): FileIssue[] | { code: 'invalid_type' | 'invalid_uuid'; path: readonly (string | number)[] }[] {
  if (typeof value === 'string') return isFileId(value) ? [] : [{ code: 'invalid_uuid', path }]
  if (isFacts(value)) return checkFile(value, rules, path)
  return [{ code: 'invalid_type', path }]
}

function schema<T>(
  validate: (value: unknown) => readonly FileSchemaIssue[],
): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'strutvane-files',
      validate: (value) => {
        const issues = validate(value)
        return issues.length > 0 ? { issues } : { value: value as T }
      },
    },
  }
}

function fileSchemaExtension(
  rules: ResolvedRules,
  extra: Readonly<Record<string, unknown>> = {},
): JsonSchema {
  return {
    accept: rules.accept,
    maxSize: rules.maxSize,
    minSize: rules.minSize,
    ...(rules.image.minWidth === undefined ? {} : { minWidth: rules.image.minWidth }),
    ...(rules.image.minHeight === undefined ? {} : { minHeight: rules.image.minHeight }),
    ...(rules.image.maxWidth === undefined ? {} : { maxWidth: rules.image.maxWidth }),
    ...(rules.image.maxHeight === undefined ? {} : { maxHeight: rules.image.maxHeight }),
    ...extra,
  }
}

const ID_COLUMN: Readonly<Record<SqlDialect, ColumnSpec>> = {
  postgres: { sqlType: 'uuid' },
  mysql: { sqlType: 'char(36)' },
  sqlite: { sqlType: 'text' },
}

const IDS_COLUMN: Readonly<Record<SqlDialect, ColumnSpec>> = {
  postgres: { sqlType: 'jsonb' },
  mysql: { sqlType: 'json' },
  sqlite: { sqlType: 'text' },
}

const SINGLE_OPERATORS: readonly FilterOperator[] = ['eq', 'in', 'isNull', 'isNotNull']
const MULTI_OPERATORS: readonly FilterOperator[] = ['isNull', 'isNotNull']

function makeSingle(
  name: string,
  widget: string,
  rulesOf: (options: FileFieldOptions) => ResolvedRules,
  extra: (options: ImageFieldOptions) => Readonly<Record<string, unknown>>,
): FieldType<FileValue | null, FileFieldOptions> {
  return Object.freeze({
    name,
    widget,
    filterOperators: SINGLE_OPERATORS,
    column: (dialect: SqlDialect): ColumnSpec => ID_COLUMN[dialect],
    validator(options: FileFieldOptions): StandardSchemaV1<unknown, FileValue | null> {
      const rules = rulesOf(options)
      const label = options.label ?? 'The file'
      return schema<FileValue | null>((value) => {
        if (value === null || value === undefined)
          return options.required ? [toSchemaIssue(fileIssue('required', []), label)] : []
        return single(value, rules, []).map((i) => toSchemaIssue(i, label))
      })
    },
    jsonSchema(options: FileFieldOptions): JsonSchema {
      const base = {
        type: 'string',
        format: 'uuid',
        'x-strutvane-file': fileSchemaExtension(rulesOf(options), extra(options)),
      }
      return options.required ? base : { ...base, nullable: true }
    },
  })
}

/** A single file, e.g. an invoice PDF. Column: the file id. Widget: `file`. */
export const fileField: FieldType<FileValue | null, FileFieldOptions> = makeSingle(
  'file',
  'file',
  (o) => resolveRules(o),
  () => ({}),
)

/**
 * A single image. Defaults `accept` to PNG, JPEG, GIF, WebP and AVIF; images are decoded with a
 * pixel cap and stripped of metadata on upload. Widget: `image`.
 */
export const imageField: FieldType<FileValue | null, ImageFieldOptions> = makeSingle(
  'image',
  'image',
  (o) => resolveRules({ ...o, accept: o.accept ?? DEFAULT_IMAGE_TYPES }),
  (o) => (o.variants ? { variants: Object.keys(o.variants) } : {}),
)

/** Several files in order, e.g. attachments. Column: a JSON array of ids. Widget: `files`. */
export const filesField: FieldType<readonly FileValue[], FilesFieldOptions> = Object.freeze({
  name: 'files',
  widget: 'files',
  filterOperators: MULTI_OPERATORS,
  column: (dialect: SqlDialect): ColumnSpec => IDS_COLUMN[dialect],
  validator(options: FilesFieldOptions): StandardSchemaV1<unknown, readonly FileValue[]> {
    const rules = resolveRules(options)
    const count = resolveCount(options)
    const label = options.label ?? 'The files'
    return schema<readonly FileValue[]>((value) => {
      const list = value === null || value === undefined ? [] : value
      if (!Array.isArray(list)) return [toSchemaIssue({ code: 'invalid_type', path: [] }, label)]
      if (list.length === 0 && (options.required || count.min > 0))
        return [toSchemaIssue(fileIssue('required', []), label)]
      if (list.length > count.max)
        return [
          toSchemaIssue(
            fileIssue('too_many_files', [], { max: count.max, count: list.length }),
            label,
          ),
        ]
      if (list.length < count.min)
        return [toSchemaIssue({ code: 'too_short', path: [], params: { min: count.min } }, label)]
      const ids = list.filter((v): v is string => typeof v === 'string')
      if (new Set(ids).size !== ids.length)
        return [toSchemaIssue({ code: 'invalid', path: [] }, label)]
      return list.flatMap((item, i) =>
        single(item, rules, [i]).map((issue) => toSchemaIssue(issue, label)),
      )
    })
  },
  jsonSchema(options: FilesFieldOptions): JsonSchema {
    const count = resolveCount(options)
    return {
      type: 'array',
      items: { type: 'string', format: 'uuid' },
      uniqueItems: true,
      minItems: count.min,
      maxItems: count.max,
      'x-strutvane-file': fileSchemaExtension(resolveRules(options)),
    }
  },
})
