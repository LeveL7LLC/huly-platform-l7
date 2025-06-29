<!--
// Copyright © 2022 Hardcore Engineering Inc.
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
  import { getObjectValue, type Class, type Doc, type Ref } from '@hcengineering/core'
  import { getResource, type IntlString } from '@hcengineering/platform'
  import {
    AnySvelteComponent,
    Button,
    EditWithIcon,
    FocusHandler,
    Icon,
    IconAdd,
    IconCheck,
    IconSearch,
    ListView,
    Spinner,
    createFocusManager,
    deviceOptionsStore,
    resizeObserver,
    showPopup,
    tooltip
  } from '@hcengineering/ui'
  import view from '@hcengineering/view'
  import { createEventDispatcher } from 'svelte'
  import presentation from '..'
  import { ObjectCreate } from '../types'
  import { getClient } from '../utils'

  export let _class: Ref<Class<Doc>>
  export let objects: Doc[] = []
  export let selected: Ref<Doc> | undefined = undefined

  export let multiSelect: boolean = false
  export let closeAfterSelect: boolean = true
  export let allowDeselect: boolean = false
  export let titleDeselect: IntlString | undefined = undefined
  export let placeholder: IntlString = presentation.string.Search
  export let selectedObjects: Ref<Doc>[] = []
  export let shadows: boolean = true
  export let width: 'medium' | 'large' | 'full' | 'auto' = 'medium'
  export let size: 'small' | 'medium' | 'large' = 'large'

  export let noSearchField: boolean = false
  export let groupBy = '_class'

  export let create: ObjectCreate | undefined = undefined
  export let readonly = false
  export let disallowDeselect: Ref<Doc>[] | undefined = undefined
  export let created: Doc[] = []
  export let embedded: boolean = false
  export let loading: boolean = false
  export let type: 'text' | 'object' | 'presenter' = 'text'

  let search: string = ''

  $: selectedElements = new Set(selectedObjects)

  const dispatch = createEventDispatcher()

  $: showCategories =
    created.length > 0 ||
    objects.map((it) => getObjectValue(groupBy, it)).filter((it, index, arr) => arr.indexOf(it) === index).length > 1 ||
    selectedObjects.length > 0

  let presenter: AnySvelteComponent | undefined = undefined
  $: if (type === 'presenter') {
    findObjectPresenter(_class)
  }

  const checkSelected = (item?: Doc): void => {
    if (item === undefined) {
      return
    }
    if (selectedElements.has(item._id)) {
      selectedElements.delete(item._id)
    } else {
      selectedElements.add(item._id)
    }

    selectedObjects = Array.from(selectedElements)

    dispatch('update', selectedObjects)
  }

  let selection = 0
  let list: ListView

  async function handleSelection (evt: Event | undefined, objects: Doc[], selection: number): Promise<void> {
    const item = objects[selection]
    if (item === undefined) {
      return
    }

    if (!multiSelect) {
      if (allowDeselect) {
        selected = item._id === selected ? undefined : item._id
      } else {
        selected = item._id
      }
      dispatch(closeAfterSelect ? 'close' : 'update', selected !== undefined ? item : undefined)
    } else {
      checkSelected(item)
    }
  }

  function onKeydown (key: KeyboardEvent): void {
    if (key.code === 'ArrowUp') {
      key.stopPropagation()
      key.preventDefault()
      list.select(selection - 1)
    }
    if (key.code === 'ArrowDown') {
      key.stopPropagation()
      key.preventDefault()
      list.select(selection + 1)
    }
    if (key.code === 'Enter') {
      key.preventDefault()
      key.stopPropagation()
      void handleSelection(key, objects, selection)
    }
  }
  const manager = createFocusManager()

  function onCreate (): void {
    if (create === undefined) {
      return
    }
    const c = create
    showPopup(c.component, c.props ?? {}, 'top', async (res) => {
      if (res != null) {
        // We expect reference to new object.
        const newPerson = await getClient().findOne(_class, { _id: res })
        if (newPerson !== undefined) {
          search = c.update?.(newPerson) ?? ''
          dispatch('created', newPerson)
          dispatch('search', search)
        }
      }
    })
  }
  function toAny (obj: any): any {
    return obj
  }

  const forbiddenDeselectItemIds = new Set(disallowDeselect)

  function getGroup (doc: Doc, groupBy: any): any {
    if (created.find((it) => it._id === doc._id) !== undefined) {
      return '_created'
    }
    if ((selectedObjects ?? []).find((it) => it === doc._id) !== undefined) {
      return '_selected'
    }
    return getObjectValue(groupBy, toAny(doc))
  }

  function findObjectPresenter (_class: Ref<Class<Doc>>): void {
    const presenterMixin = getClient().getHierarchy().classHierarchyMixin(_class, view.mixin.ObjectPresenter)
    if (presenterMixin?.presenter !== undefined) {
      getResource(presenterMixin.presenter)
        .then((result) => {
          presenter = result
        })
        .catch((err) => {
          console.error('Failed to find presenter for class ' + _class, err)
        })
    }
  }
</script>

<FocusHandler {manager} />

<!-- svelte-ignore a11y-no-static-element-interactions -->
<div
  class="selectPopup"
  class:full-width={width === 'full'}
  class:plainContainer={!shadows}
  class:width-40={width === 'large'}
  class:auto={width === 'auto'}
  class:embedded
  on:keydown={onKeydown}
  use:resizeObserver={() => {
    dispatch('changeContent')
  }}
>
  {#if !noSearchField}
    <div class="header flex-between">
      <EditWithIcon
        icon={IconSearch}
        size={'large'}
        width={'100%'}
        autoFocus={!$deviceOptionsStore.isMobile}
        bind:value={search}
        on:change={() => dispatch('search', search)}
        on:input={() => dispatch('search', search)}
        {placeholder}
      />
      {#if create !== undefined}
        <div class="ml-2">
          <Button
            focusIndex={2}
            kind={'ghost'}
            {size}
            icon={IconAdd}
            showTooltip={{ label: create.label }}
            dataId={'btnAdd'}
            on:click={onCreate}
            disabled={readonly || loading}
          />
        </div>
      {/if}
    </div>
  {:else if !embedded}
    <div class="menu-space" />
  {/if}
  <div class="scroll">
    <div class="box">
      <ListView bind:this={list} count={objects.length} bind:selection>
        <svelte:fragment slot="category" let:item>
          {#if showCategories}
            {@const obj = toAny(objects[item])}
            {#if item === 0 || (item > 0 && getGroup(objects[item - 1], groupBy) !== getGroup(obj, groupBy))}
              <!--Category for first item-->
              {#if item > 0}<div class="menu-separator" />{/if}
              <div class="category-box">
                <slot name="category" item={obj} />
              </div>
            {/if}
          {/if}
        </svelte:fragment>
        <svelte:fragment slot="item" let:item>
          {@const obj = objects[item]}
          {@const isDeselectDisabled = selectedElements.has(obj._id) && forbiddenDeselectItemIds.has(obj._id)}
          <button
            class="menu-item withList w-full flex-row-center"
            disabled={readonly || isDeselectDisabled || loading}
            on:click={() => {
              void handleSelection(undefined, objects, item)
            }}
          >
            {#if type === 'text'}
              <span class="label" class:disabled={readonly || isDeselectDisabled || loading}>
                <slot name="item" item={obj} />
              </span>
            {:else if type === 'presenter'}
              {#if presenter !== undefined}
                <svelte:component this={presenter} value={obj} />
              {/if}
            {:else}
              <slot name="item" item={obj} />
            {/if}
            {#if (allowDeselect && selected) || multiSelect || selected}
              <div class="check" class:disabled={readonly}>
                {#if obj._id === selected || selectedElements.has(obj._id)}
                  {#if loading}
                    <Spinner size={'small'} />
                  {:else}
                    <div use:tooltip={{ label: titleDeselect ?? presentation.string.Deselect }}>
                      <Icon icon={IconCheck} size={'small'} />
                    </div>
                  {/if}
                {/if}
              </div>
            {/if}
          </button>
        </svelte:fragment>
      </ListView>
    </div>
  </div>
  {#if !embedded}<div class="menu-space" />{/if}
</div>

<style lang="scss">
  .plainContainer {
    color: var(--caption-color);
    background-color: var(--theme-bg-color);
    border: 1px solid var(--button-border-color);
    border-radius: 0.25rem;
    box-shadow: none;
  }
</style>
