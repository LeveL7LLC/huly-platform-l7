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
  import core, { DateRangeMode, TypeDate as DateType } from '@hcengineering/core'
  import { TypeDate } from '@hcengineering/model'
  import { IntlString } from '@hcengineering/platform'
  import { DropdownLabelsIntl, Label, DropdownIntlItem } from '@hcengineering/ui'
  import { createEventDispatcher, onMount } from 'svelte'
  import setting from '../../plugin'
  import type { ButtonKind, ButtonSize } from '@hcengineering/ui'

  export let type: DateType | undefined
  export let editable: boolean = true
  export let kind: ButtonKind = 'regular'
  export let size: ButtonSize = 'medium'
  export let width: string | undefined = undefined

  const dispatch = createEventDispatcher()
  const items: DropdownIntlItem[] = [
    {
      id: DateRangeMode.DATE,
      label: setting.string.DateOnly
    },
    {
      id: DateRangeMode.TIME,
      label: setting.string.OnlyTime
    },
    {
      id: DateRangeMode.DATETIME,
      label: setting.string.DateAndTime
    }
  ]

  let selected = items.find((item) => item.id === type?.mode)?.id
  const label = items.find((item) => item.id === type?.mode)?.label ?? ('' as IntlString)

  onMount(() => {
    if (type?._class !== core.class.TypeDate) {
      dispatch('change', { type: TypeDate() })
    }
  })
</script>

<span class="label">
  <Label label={setting.string.DateMode} />
</span>
{#if editable}
  <DropdownLabelsIntl
    {selected}
    {items}
    {kind}
    {size}
    {width}
    label={setting.string.DateMode}
    on:selected={(res) => {
      selected = res.detail
      dispatch('change', { type: TypeDate(res.detail) })
    }}
  />
{:else}
  <Label {label} />
{/if}
