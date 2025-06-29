<!--
// Copyright © 2022, 2023 Hardcore Engineering Inc.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
-->
<script lang="ts">
  import {
    getObjectValue,
    type Class,
    type Doc,
    type DocumentQuery,
    type FindOptions,
    type Ref
  } from '@hcengineering/core'
  import type { IntlString } from '@hcengineering/platform'
  import { Label } from '@hcengineering/ui'
  import { createEventDispatcher } from 'svelte'
  import presentation, { searchFor, type SearchItem } from '..'
  import { ObjectCreate, type ObjectSearchCategory } from '../types'
  import { createQuery } from '../utils'
  import DocPopup from './DocPopup.svelte'

  export let _class: Ref<Class<Doc>>
  export let options: FindOptions<Doc> | undefined = undefined
  export let selected: Ref<Doc> | undefined = undefined

  export let docQuery: DocumentQuery<Doc> | undefined = undefined

  export let multiSelect: boolean = false
  export let closeAfterSelect: boolean = true
  export let allowDeselect: boolean = false
  export let titleDeselect: IntlString | undefined = undefined
  export let placeholder: IntlString = presentation.string.Search
  export let selectedObjects: Ref<Doc>[] = []
  export let ignoreObjects: Ref<Doc>[] = []
  export let shadows: boolean = true
  export let width: 'medium' | 'large' | 'full' | 'auto' = 'medium'
  export let size: 'small' | 'medium' | 'large' = 'large'

  export let searchMode: 'field' | 'fulltext' | 'disabled' | 'spotlight' = 'field'
  export let category: Ref<ObjectSearchCategory> | undefined = undefined
  export let searchField: string = 'name'
  export let groupBy = '_class'

  export let create: ObjectCreate | undefined = undefined
  export let readonly = false
  export let disallowDeselect: Ref<Doc>[] | undefined = undefined
  export let embedded: boolean = false
  export let loading: boolean = false
  export let type: 'text' | 'object' | 'presenter' = 'text'

  export let filter: (it: Doc) => boolean = () => {
    return true
  }

  export let sort: <T extends Doc>(a: T, b: T) => number = (a, b) => {
    const aval: string = `${getObjectValue(groupBy, a as any)}`
    const bval: string = `${getObjectValue(groupBy, b as any)}`
    return aval.localeCompare(bval)
  }

  const created: Doc[] = []
  const dispatch = createEventDispatcher()

  let noSearchField: boolean = false
  let search: string = ''
  let objects: Doc[] = []
  let selObjects: Doc[] = []
  let resObjects: Doc[] = []

  let extraItems: Ref<Doc>[] = []

  const query = createQuery()
  const sQuery = createQuery() // Query for selected objects

  $: noSearchField = searchMode === 'disabled'
  $: _idExtra = typeof docQuery?._id === 'object' ? docQuery?._id : {}
  $: if (searchMode === 'spotlight' && search !== '') {
    void searchSpotlight(search).then((items) => {
      extraItems = items.map((it) => it.item.id)
    })
  } else {
    extraItems = []
  }

  $: fquery = {
    ...(docQuery ?? {}),
    ...(() => {
      switch (searchMode) {
        case 'disabled':
          return { _id: { $nin: ignoreObjects, ..._idExtra } }
        case 'fulltext':
          return search !== ''
            ? { $search: search, _id: { $nin: ignoreObjects, ..._idExtra } }
            : { _id: { $nin: ignoreObjects, ..._idExtra } }
        case 'spotlight':
          return extraItems.length > 0
            ? { _id: { $in: extraItems, $nin: ignoreObjects } }
            : { _id: { $nin: ignoreObjects, ..._idExtra } }
        default:
          return search !== ''
            ? { [searchField]: { $like: '%' + search + '%' }, _id: { $nin: ignoreObjects, ..._idExtra } }
            : { _id: { $nin: ignoreObjects, ..._idExtra } }
      }
    })()
  }

  $: query.query<Doc>(
    _class,
    fquery,
    (result) => {
      result.sort(sort)
      resObjects = result
    },
    { ...(options ?? {}), limit: 200 }
  )

  $: if (selectedObjects.length > 0) {
    sQuery.query<Doc>(
      _class,
      search !== ''
        ? { [searchField]: { $like: '%' + search + '%' }, _id: { $in: selectedObjects } }
        : { _id: { $in: selectedObjects } },
      (result) => {
        result.sort(sort)
        selObjects = result
      },
      {}
    )
  } else {
    sQuery.unsubscribe()
  }

  $: {
    if (created.length > 0 || selObjects.length > 0) {
      const cmap = new Set(created.map((it) => it._id))
      const smap = new Set(selObjects.map((it) => it._id))

      objects = [...created, ...selObjects, ...resObjects.filter((d) => !cmap.has(d._id) && !smap.has(d._id))].filter(
        filter
      )
    } else {
      objects = resObjects.filter(filter)
    }
  }

  async function searchSpotlight (search: string): Promise<SearchItem[]> {
    return (await searchFor('spotlight', search, category, 50)).items
  }
</script>

<DocPopup
  {_class}
  {objects}
  {selected}
  {multiSelect}
  {closeAfterSelect}
  {allowDeselect}
  {titleDeselect}
  {placeholder}
  {selectedObjects}
  {shadows}
  {width}
  {size}
  {noSearchField}
  {groupBy}
  {create}
  {readonly}
  {disallowDeselect}
  {embedded}
  {loading}
  {type}
  on:update={(e) => {
    selectedObjects = e.detail
    dispatch('update', e.detail)
  }}
  on:close
  on:changeContent
  on:search={(e) => (search = e.detail)}
  on:created={(doc) => {
    created.push(doc.detail)
    if (!multiSelect) dispatch('created', doc.detail)
  }}
  {created}
>
  <svelte:fragment slot="item" let:item>
    {#if $$slots.item}
      <slot name="item" {item} />
    {/if}
  </svelte:fragment>
  <svelte:fragment slot="category" let:item>
    {#if created.length > 0 && created.includes(item._id)}
      <div class="menu-group__header">
        <span class="overflow-label">
          <Label label={presentation.string.Created} />
        </span>
      </div>
    {:else if selectedObjects.length > 0 && selectedObjects.includes(item._id)}
      <div class="menu-group__header">
        <span class="overflow-label">
          <Label label={presentation.string.Selected} />
        </span>
      </div>
    {:else if $$slots.category}
      <slot name="category" {item} />
    {/if}
  </svelte:fragment>
</DocPopup>
