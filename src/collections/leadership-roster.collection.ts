import type { CollectionConfig } from '@sonicjs-cms/core'

/** The Pack 170 volunteer leadership roster. One record represents one role. */
export default {
  name: 'leadership-roster',
  displayName: 'Volunteer leadership roster',
  description: 'The current adult volunteers who lead Pack 170.',
  icon: '🧭',

  schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        title: 'Role',
        required: true,
        maxLength: 120,
        helpText: 'For example: Cubmaster or Tiger Den Leader (1st).',
      },
      name: {
        type: 'string',
        title: 'Volunteer name',
        maxLength: 120,
        helpText: 'Leave blank when the role is vacant.',
      },
      section: {
        type: 'select',
        title: 'Roster section',
        required: true,
        enum: ['pack-leadership', 'den-leaders'],
        enumLabels: ['Pack leadership', 'Den leaders'],
        default: 'pack-leadership',
      },
      sortOrder: {
        type: 'number',
        title: 'Display order',
        required: true,
        default: 0,
        helpText: 'Lower numbers appear first within a section.',
      },
    },
    required: ['title', 'section', 'sortOrder'],
  },

  listFields: ['title', 'name', 'section', 'sortOrder'],
  searchFields: ['title', 'name'],
  defaultSort: 'sortOrder',
  defaultSortOrder: 'asc',
} satisfies CollectionConfig
