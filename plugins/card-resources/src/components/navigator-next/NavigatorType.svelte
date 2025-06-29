<!--
// Copyright © 2025 Hardcore Engineering Inc.
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
  import view from '@hcengineering/view'
  import { IconAdd, NavGroup, Action, NavItem } from '@hcengineering/ui'
  import { Ref } from '@hcengineering/core'
  import { createEventDispatcher } from 'svelte'
  import { CardSpace, MasterTag } from '@hcengineering/card'
  import { IconWithEmoji, getClient } from '@hcengineering/presentation'

  import type { NavigatorConfig } from '../../types'
  import cardPlugin from '../../plugin'
  import { createCard } from '../../utils'

  export let type: MasterTag
  export let level: number = -1
  export let space: CardSpace | undefined = undefined
  export let config: NavigatorConfig
  export let selectedType: Ref<MasterTag> | undefined = undefined
  export let empty: boolean = false
  export let active: boolean = false
  export let showIcon: boolean = false

  const dispatch = createEventDispatcher()

  async function handleCreateCard (): Promise<void> {
    if (space === undefined) return
    const _id = await createCard(type._id, space._id)
    const card = await getClient().findOne(cardPlugin.class.Card, { _id })
    if (card === undefined) return
    dispatch('selectCard', card)
  }

  function getActions (): Action[] {
    const result: Action[] = []

    if (config.allowCreate === true && space !== undefined) {
      result.push({
        id: 'create-card',
        label: cardPlugin.string.CreateCard,
        icon: IconAdd,
        action: async (): Promise<void> => {
          await handleCreateCard()
        }
      })
    }

    return result
  }
</script>

{#if level > -1}
  <NavItem
    _id={type._id}
    label={type.label}
    icon={type.icon === view.ids.IconWithEmoji ? IconWithEmoji : type.icon}
    iconProps={type.icon === view.ids.IconWithEmoji ? { icon: type.color } : {}}
    isFold
    {empty}
    {level}
    selected={selectedType === type._id}
    on:click={(e) => {
      e.stopPropagation()
      e.preventDefault()
      dispatch('selectType', type)
    }}
  >
    <svelte:fragment slot="dropbox">
      <slot />
    </svelte:fragment>
  </NavItem>
{:else}
  <NavGroup
    _id={type._id}
    categoryName={type._id}
    label={type.label}
    icon={showIcon ? (type.icon === view.ids.IconWithEmoji ? IconWithEmoji : type.icon) : undefined}
    iconProps={type.icon === view.ids.IconWithEmoji ? { icon: type.color } : {}}
    highlighted={active}
    selected={selectedType === type._id}
    {empty}
    isFold
    visible={active}
    type="selectable-header"
    actions={getActions()}
    on:click={(e) => {
      e.stopPropagation()
      e.preventDefault()
      dispatch('selectType', type)
    }}
  >
    <div class="mt-0-5" />
    <slot />
    <svelte:fragment slot="visible" let:isOpen>
      <slot name="visible" {isOpen} />
    </svelte:fragment>
  </NavGroup>
{/if}
