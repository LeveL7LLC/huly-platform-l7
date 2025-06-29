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
  import { getMetadata } from '@hcengineering/platform'
  import uiPlugin, { closePopup, closeTooltip, navigate, parseLocation } from '@hcengineering/ui'
  import presentation from '../plugin'

  export let href: string | undefined
  export let title: string | undefined = undefined
  export let disabled = false
  export let onClick: ((event: MouseEvent) => void) | undefined = undefined
  export let noUnderline = disabled
  export let inline = false
  export let colorInherit: boolean = false
  export let shrink: number = 1
  export let accent: boolean = false
  export let noOverflow: boolean = false
  export let inlineReference: boolean = false
  export let transparent: boolean = false
  export let inlineBlock = false
  export let noSelect: boolean = true
  export let maxWidth: string | undefined = undefined

  function clickHandler (e: MouseEvent): void {
    if (disabled) return

    if (onClick !== undefined) {
      e.preventDefault()
      e.stopPropagation()
      onClick(e)
    } else if (href !== undefined) {
      if (e.metaKey || e.ctrlKey) {
        e.stopPropagation()
        return
      }

      // we need to close popups and tooltips
      closePopup()
      closeTooltip()
      try {
        const url = new URL(href)
        const frontUrl = getMetadata(presentation.metadata.FrontUrl) ?? window.location.origin
        if (url.origin === frontUrl) {
          const loc = parseLocation(url)
          const routes = getMetadata(uiPlugin.metadata.Routes)
          const app = routes?.get(loc.path[0])

          if (app !== undefined) {
            e.preventDefault()
            e.stopPropagation()
            navigate(loc)
          }
        }
      } catch {}
    }
  }
</script>

{#if disabled || href === undefined}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <span
    class:cursor-pointer={!disabled}
    class:cursor-default={disabled}
    class:noUnderline={noUnderline || disabled}
    class:noOverflow
    class:inline
    class:inlineBlock
    class:colorInherit
    class:antiMention={inlineReference}
    class:transparent
    class:fs-bold={accent}
    class:select-text={!noSelect}
    style:flex-shrink={shrink}
    style:max-width={maxWidth}
    {title}
    on:click={clickHandler}
  >
    <slot />
  </span>
{:else}
  <a
    {href}
    class:noUnderline={noUnderline || disabled}
    class:noOverflow
    class:inline
    class:inlineBlock
    class:colorInherit
    class:antiMention={inlineReference}
    class:transparent
    class:fs-bold={accent}
    style:flex-shrink={shrink}
    style:max-width={maxWidth}
    class:select-text={!noSelect}
    {title}
    on:click={clickHandler}
  >
    <slot />
  </a>
{/if}

<style lang="scss">
  span,
  a:not(.antiMention) {
    min-width: 0;
    font-weight: inherit;

    &:not(.noOverflow) {
      overflow: hidden;
      white-space: nowrap;
      word-break: break-all;
      text-overflow: ellipsis;
    }
    &:not(.colorInherit) {
      color: var(--theme-content-color);
    }
    &.colorInherit,
    &.inline {
      color: inherit;
    }
    &.inline {
      display: inline-flex;
      align-items: center;
      text-decoration: none;
    }

    &.inlineBlock {
      display: inline-block;
    }

    &.noUnderline {
      text-decoration: none;
      &:not(.colorInherit) {
        color: var(--theme-caption-color);
      }
    }

    &:not(.noUnderline, .inline) {
      &:hover {
        text-decoration: underline;
        &:not(.colorInherit) {
          color: var(--theme-caption-color);
        }
      }
    }

    &:active {
      color: var(--theme-content-color);
    }
  }
</style>
