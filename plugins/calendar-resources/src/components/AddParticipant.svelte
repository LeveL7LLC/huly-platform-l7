<!--
// Copyright © 2023 Hardcore Engineering Inc.
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
  import contact, { Person } from '@hcengineering/contact'
  import { CreateGuest, getPersonRefByPersonId } from '@hcengineering/contact-resources'
  import { Ref, type PersonId } from '@hcengineering/core'
  import { IntlString, translateCB } from '@hcengineering/platform'
  import { createQuery, getClient } from '@hcengineering/presentation'
  import setting, { Integration } from '@hcengineering/setting'
  import { themeStore } from '@hcengineering/theme'
  import { Button, IconAdd, closePopup, registerFocus, resizeObserver, showPopup } from '@hcengineering/ui'
  import { afterUpdate, createEventDispatcher, onMount } from 'svelte'
  import calendar from '../plugin'
  import ParticipantsPopup from './ParticipantsPopup.svelte'

  export let maxWidth: string | undefined = undefined
  export let value: string | undefined = undefined
  export let placeholder: IntlString
  export let autoFocus: boolean = false
  export let select: boolean = false
  export let focusable: boolean = false
  export let disabled: boolean = false
  export let excluded: Ref<Person>[] = []
  export let fullSize: boolean = false

  const dispatch = createEventDispatcher()

  let text: HTMLElement
  let input: HTMLInputElement
  let style: string
  let phTranslate: string = ''
  let parentWidth: number | undefined

  $: style = `max-width: ${maxWidth || (parentWidth ? `${parentWidth}px` : 'max-content')};`
  $: translateCB(placeholder, {}, $themeStore.language, (res) => {
    phTranslate = res
  })

  function computeSize (t: HTMLInputElement | EventTarget | null) {
    if (t == null) {
      return
    }
    const target = t as HTMLInputElement
    const value = target.value
    text.innerHTML = (value === '' ? phTranslate : value)
      .replaceAll(' ', '&nbsp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
    target.style.width = Math.max(text.clientWidth, 50) + 'px'
    dispatch('input')
  }

  onMount(() => {
    if (autoFocus) {
      input.focus()
      autoFocus = false
    }
    if (select) {
      input.select()
      select = false
    }
    computeSize(input)
  })

  afterUpdate(() => {
    computeSize(input)
  })

  export function focusInput () {
    input?.focus()
  }
  export function selectInput () {
    input?.select()
  }

  // Focusable control with index
  export let focusIndex = -1
  const { idx, focusManager } = registerFocus(focusIndex, {
    focus: () => {
      focusInput()
      return input != null
    },
    isFocus: () => document.activeElement === input
  })
  const updateFocus = () => {
    focusManager?.setFocus(idx)
  }
  $: if (input) {
    input.addEventListener('focus', updateFocus, { once: true })
  }

  export function focus (): void {
    input.focus()
  }

  const client = getClient()
  let integrations: Integration[] = []

  const integrationsQuery = createQuery()
  integrationsQuery.query(
    setting.class.Integration,
    { type: calendar.integrationType.Calendar, disabled: false },
    (res) => {
      integrations = res
    }
  )

  $: findCompletions(value, integrations, excluded)

  async function findCompletions (
    val: string | undefined,
    integrations: Integration[],
    excluded: Ref<Person>[]
  ): Promise<void> {
    if (val === undefined || val.length < 3) {
      closePopup('participants')
      return
    }
    const persons = client.findAll(contact.class.Person, { $search: `${val}*`, _id: { $nin: excluded } }, { limit: 5 })
    const res = new Set<Ref<Person>>()
    for (const integration of integrations) {
      if (integration.value.includes(val)) {
        const authorPerson = await getPersonRefByPersonId(integration.createdBy ?? integration.modifiedBy)
        if (authorPerson != null && !excluded.includes(authorPerson)) {
          res.add(authorPerson)
        }
      }
    }
    for (const person of await persons) {
      res.add(person._id)
    }
    if (res.size > 0) {
      closePopup('participants')
      showPopup(
        ParticipantsPopup,
        { participants: Array.from(res) },
        input,
        (res) => {
          if (res) {
            value = ''
            dispatch('ref', res)
          }
        },
        undefined,
        { category: 'participants', overlay: true }
      )
    } else {
      closePopup('participants')
    }
  }

  function addGuest (e: MouseEvent) {
    showPopup(CreateGuest, {}, undefined, (res) => {
      if (res) {
        value = ''
        dispatch('ref', res)
      }
    })
  }
</script>

<!-- svelte-ignore a11y-click-events-have-key-events -->
<!-- svelte-ignore a11y-no-static-element-interactions -->
<div
  class="antiEditBox"
  class:flex-grow={fullSize}
  class:w-full={focusable}
  on:click={() => {
    input.focus()
  }}
  use:resizeObserver={(element) => {
    parentWidth = element.parentElement?.getBoundingClientRect().width
  }}
  on:keydown={(ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault()
      ev.stopPropagation()
      dispatch('enter', value)
      value = ''
    }
  }}
>
  <div class="hidden-text" bind:this={text} />
  <div class="flex-row-center w-full container">
    <div class="antiEditBox ghost" class:focusable class:w-full={fullSize}>
      <input
        {disabled}
        bind:this={input}
        type="text"
        bind:value
        placeholder={phTranslate}
        {style}
        class="antiEditBoxInput search"
        on:input={(ev) => {
          computeSize(ev.target)
        }}
        on:change
        on:keydown
        on:keypress
        on:blur
      />
    </div>
    <div class="tool">
      <Button
        {disabled}
        focusIndex={2}
        kind={'ghost'}
        size={'small'}
        icon={IconAdd}
        showTooltip={{
          label: contact.string.AddGuest
        }}
        on:click={addGuest}
      />
    </div>
  </div>
</div>

<style lang="scss">
  .tool {
    visibility: hidden;
  }

  .container:hover {
    .tool {
      visibility: visible;
    }
  }
</style>
