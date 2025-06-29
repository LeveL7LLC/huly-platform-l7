<!--
// Copyright © 2020 Anticrm Platform Contributors.
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
  import { Analytics } from '@hcengineering/analytics'
  import attachment, { AttachmentsEvents } from '@hcengineering/attachment'
  import contact, {
    AvatarType,
    Channel,
    ChannelProvider,
    combineName,
    findContacts,
    Person
  } from '@hcengineering/contact'
  import { ChannelsDropdown, EditableAvatar, PersonPresenter } from '@hcengineering/contact-resources'
  import core, {
    Account,
    AttachedData,
    Data,
    Doc,
    fillDefaults,
    generateId,
    MixinData,
    Ref,
    toIdMap,
    TxProcessor,
    WithLookup,
    type Blob
  } from '@hcengineering/core'
  import { getMetadata, getResource, setPlatformStatus, unknownError } from '@hcengineering/platform'
  import presentation, {
    Card,
    createQuery,
    deleteFile,
    DraftController,
    FilePreviewPopup,
    getClient,
    InlineAttributeBar,
    KeyedAttribute,
    MessageBox,
    MultipleDraftController
  } from '@hcengineering/presentation'
  import { Candidate, CandidateDraft, RecruitEvents } from '@hcengineering/recruit'
  import { recognizeDocument } from '@hcengineering/rekoni'
  import tags, { findTagCategory, TagElement, TagReference } from '@hcengineering/tags'
  import {
    Button,
    Component,
    createFocusManager,
    EditBox,
    IconFile as FileIcon,
    FocusHandler,
    getColorNumberByText,
    IconAttachment,
    IconInfo,
    Label,
    MiniToggle,
    showPopup,
    Spinner,
    ActionIcon
  } from '@hcengineering/ui'
  import { createEventDispatcher, onDestroy } from 'svelte'
  import recruit from '../plugin'
  import { getCandidateIdentifier } from '../utils'
  import YesNo from './YesNo.svelte'
  import IconShuffle from './icons/Shuffle.svelte'

  export let shouldSaveDraft: boolean = true

  const mDraftController = new MultipleDraftController(recruit.mixin.Candidate)
  const id: Ref<Candidate> = generateId()
  const draftController = new DraftController<CandidateDraft>(
    shouldSaveDraft ? mDraftController.getNext() ?? id : undefined,
    recruit.mixin.Candidate
  )

  function getEmptyCandidate (id: Ref<Candidate> | undefined = undefined): CandidateDraft {
    return {
      _id: id ?? generateId(),
      firstName: '',
      lastName: '',
      title: '',
      channels: [],
      skills: [],
      city: ''
    }
  }
  const empty = {}
  const client = getClient()
  const hierarchy = client.getHierarchy()
  const ignoreKeys = ['onsite', 'remote', 'title']

  let draft = shouldSaveDraft ? draftController.get() : undefined
  let object = draft ?? getEmptyCandidate(id)
  onDestroy(
    draftController.subscribe((val) => {
      draft = shouldSaveDraft ? val : undefined
    })
  )

  function objectChange (object: CandidateDraft, empty: any) {
    if (shouldSaveDraft) {
      draftController.save(object, empty)
    }
  }

  $: objectChange(object, empty)

  interface resumeFile {
    name: string
    uuid: string
    size: number
    type: string
    lastModified: number
  }

  export function canClose (): boolean {
    return true
  }

  let avatarEditor: EditableAvatar

  fillDefaults(hierarchy, empty, recruit.mixin.Candidate)
  fillDefaults(hierarchy, object, recruit.mixin.Candidate)

  function resumeDraft () {
    return {
      uuid: object?.resumeUuid,
      name: object?.resumeName,
      size: object?.resumeSize,
      type: object?.resumeType,
      lastModified: object?.resumeLastModified
    }
  }

  const dispatch = createEventDispatcher()

  let inputFile: HTMLInputElement
  let loading = false
  let dragover = false
  let shouldCreateNewSkills = false

  let avatar: File | undefined = draft?.avatar

  let matches: WithLookup<Person>[] = []
  let matchedChannels: AttachedData<Channel>[] = []

  const key: KeyedAttribute = {
    key: 'skills',
    attr: client.getHierarchy().getAttribute(recruit.mixin.Candidate, 'skills')
  }

  let elements = new Map<Ref<TagElement>, TagElement>()
  let namedElements = new Map<string, TagElement>()

  const newElements: TagElement[] = []

  const elementQuery = createQuery()
  let elementsPromise: Promise<void>
  $: elementsPromise = new Promise((resolve) => {
    elementQuery.query(
      tags.class.TagElement,
      {
        targetClass: recruit.mixin.Candidate
      },
      (result) => {
        const ne = new Map<Ref<TagElement>, TagElement>()
        const nne = new Map<string, TagElement>()
        for (const t of newElements.concat(result)) {
          ne.set(t._id, t)
          nne.set(t.title.trim().toLowerCase(), t)
        }
        elements = ne
        namedElements = nne
        resolve()
      }
    )
  })

  async function createCandidate (): Promise<void> {
    const _id: Ref<Person> = generateId()
    const candidate: Data<Person> = {
      name: combineName(object.firstName ?? '', object.lastName ?? ''),
      city: object.city,
      channels: 0,
      avatarType: AvatarType.COLOR
    }
    const info = await avatarEditor.createAvatar()
    candidate.avatar = info.avatar
    candidate.avatarType = info.avatarType
    candidate.avatarProps = info.avatarProps
    const candidateData: MixinData<Person, Candidate> = {
      title: object.title,
      onsite: object.onsite,
      remote: object.remote,
      skills: 0
    }

    // Store all extra values.
    for (const [k, v] of Object.entries(object)) {
      if (v != null && k !== 'createdOn' && k !== 'avatar') {
        const attr = hierarchy.findAttribute(recruit.mixin.Candidate, k)
        if (attr === undefined) continue
        if (attr.attributeOf === recruit.mixin.Candidate) {
          if ((candidateData as any)[k] === undefined) {
            ;(candidateData as any)[k] = v
          }
        } else {
          if ((candidate as any)[k] === undefined) {
            ;(candidate as any)[k] = v
          }
        }
      }
    }

    const applyOps = client.apply(undefined, 'create-candidate')

    await applyOps.createDoc(contact.class.Person, contact.space.Contacts, candidate, _id)
    await applyOps.createMixin(
      _id,
      contact.class.Person,
      contact.space.Contacts,
      recruit.mixin.Candidate,
      candidateData
    )
    const candidateIdentifier = getCandidateIdentifier(_id)
    Analytics.handleEvent(RecruitEvents.TalentCreated, { _id: candidateIdentifier })

    if (object.resumeUuid !== undefined) {
      const resume = resumeDraft() as resumeFile
      await applyOps.addCollection(
        attachment.class.Attachment,
        contact.space.Contacts,
        _id,
        contact.class.Person,
        'attachments',
        {
          name: resume.name,
          file: resume.uuid as Ref<Blob>,
          size: resume.size,
          type: resume.type,
          lastModified: resume.lastModified
        }
      )
      Analytics.handleEvent(AttachmentsEvents.FilesAttached, { object: candidateIdentifier, count: 1 })
    }
    for (const channel of object.channels) {
      await applyOps.addCollection(
        contact.class.Channel,
        contact.space.Contacts,
        _id,
        contact.class.Person,
        'channels',
        {
          value: channel.value,
          provider: channel.provider
        }
      )
    }

    const categories = await client.findAll(tags.class.TagCategory, { targetClass: recruit.mixin.Candidate })
    // Tag elements
    const skillTagElements = toIdMap(
      await client.findAll(tags.class.TagElement, { _id: { $in: object.skills.map((it) => it.tag) } })
    )
    for (const skill of object.skills) {
      // Create update tag if missing
      if (!skillTagElements.has(skill.tag)) {
        skill.tag = await client.createDoc(tags.class.TagElement, skill.space, {
          title: skill.title,
          color: skill.color,
          targetClass: recruit.mixin.Candidate,
          description: '',
          category: findTagCategory(skill.title, categories)
        })
        Analytics.handleEvent(RecruitEvents.SkillCreated, { skill: skill.tag })
      }
      await applyOps.addCollection(skill._class, skill.space, _id, recruit.mixin.Candidate, 'skills', {
        title: skill.title,
        color: skill.color,
        tag: skill.tag,
        weight: skill.weight
      })
    }

    await applyOps.commit()
    draftController.remove()
    dispatch('close', _id)
    resetObject()
  }

  function isUndef (value?: string): boolean {
    return value === undefined || value === ''
  }

  function addChannel (channels: AttachedData<Channel>[], type: Ref<ChannelProvider>, value?: string): void {
    if (value !== undefined) {
      const provider = channels.find((e) => e.provider === type)
      if (provider === undefined) {
        channels.push({
          provider: type,
          value
        })
      } else {
        if (isUndef(provider.value)) {
          provider.value = value
        }
      }
    }
  }

  async function recognize (file: File): Promise<void> {
    const token = getMetadata(presentation.metadata.Token) ?? ''

    try {
      const doc = await recognizeDocument(token, file)

      if (isUndef(object.title) && doc.title !== undefined) {
        object.title = doc.title
      }

      if (isUndef(object.firstName) && doc.firstName !== undefined) {
        object.firstName = doc.firstName
      }

      if (isUndef(object.lastName) && doc.lastName !== undefined) {
        object.lastName = doc.lastName
      }

      if (isUndef(object.city) && doc.city !== undefined) {
        object.city = doc.city
      }

      if (!object.avatar && doc.avatar !== undefined) {
        // We had avatar, let's try to upload it.
        const data = atob(doc.avatar)
        let n = data.length
        const u8arr = new Uint8Array(n)
        while (n--) {
          u8arr[n] = data.charCodeAt(n)
        }
        avatar = new File([u8arr], doc.avatarName ?? 'avatar.png', { type: doc.avatarFormat ?? 'image/png' })
      }

      const newChannels = [...object.channels]
      addChannel(newChannels, contact.channelProvider.Email, doc.email)
      addChannel(newChannels, contact.channelProvider.GitHub, doc.github)
      addChannel(newChannels, contact.channelProvider.LinkedIn, doc.linkedin)
      addChannel(newChannels, contact.channelProvider.Phone, doc.phone)
      addChannel(newChannels, contact.channelProvider.Telegram, doc.telegram)
      addChannel(newChannels, contact.channelProvider.Twitter, doc.twitter)
      addChannel(newChannels, contact.channelProvider.Facebook, doc.facebook)
      object.channels = newChannels

      // Create skills
      await elementsPromise

      const categories = await client.findAll(tags.class.TagCategory, { targetClass: recruit.mixin.Candidate })
      const categoriesMap = toIdMap(categories)

      const newSkills: TagReference[] = []
      const formattedSkills = (doc.skills.map((s) => s.toLowerCase()) ?? []).filter(
        (skill) => !namedElements.has(skill)
      )
      const refactoredSkills: any[] = []
      if (formattedSkills.length > 0) {
        const existingTags = Array.from(namedElements.keys()).filter((x) => x.length > 2)
        const regex = /\S+(?:[-+]\S+)+/g
        const regexForEmpty = /^((?![a-zA-Zа-яА-Я]).)*$/g
        for (let sk of formattedSkills) {
          sk = sk.toLowerCase()
          const toReplace = [...new Set([...existingTags, ...refactoredSkills])]
            .filter((s) => sk.includes(s))
            .sort((a, b) => b.length - a.length)
          if (toReplace.length > 0) {
            for (const replacing of toReplace) {
              if (namedElements.has(replacing)) {
                refactoredSkills.push(replacing)
                sk = sk.replace(replacing, '').trim()
              }
            }
          }
          if (sk.includes(' ')) {
            const skSplit = sk.split(' ')
            for (const spl of skSplit) {
              const fixedTitle = regex.test(spl) ? spl.replaceAll(/[+-]/g, '') : spl
              if (namedElements.has(fixedTitle)) {
                refactoredSkills.push(fixedTitle)
                sk = sk.replace(spl, '').trim()
              }
              if ([...doc.skills, ...refactoredSkills].includes(fixedTitle)) {
                sk = sk.replace(spl, '').trim()
              }
            }
          }
          if (regex.test(sk)) {
            const fixedTitle = sk.replaceAll(/[+-]/g, '')
            if (namedElements.has(fixedTitle)) {
              refactoredSkills.push(fixedTitle)
              sk = ''
            }
          }
          if (!regexForEmpty.test(sk) && !refactoredSkills.includes(sk)) {
            refactoredSkills.push(sk)
          }
        }
      }
      const skillsToAdd = [...new Set([...doc.skills.map((s) => s.toLowerCase()), ...refactoredSkills])]
      // Create missing tag elemnts
      for (const s of skillsToAdd) {
        const title = s.trim().toLowerCase()
        let e = namedElements.get(title)
        if (e === undefined && shouldCreateNewSkills) {
          // No yet tag with title
          const category = findTagCategory(s, categories)
          const cinstance = categoriesMap.get(category)
          e = TxProcessor.createDoc2Doc(
            client.txFactory.createTxCreateDoc(tags.class.TagElement, core.space.Workspace, {
              title,
              description: `Imported skill ${s} of ${cinstance?.label ?? ''}`,
              color: getColorNumberByText(s),
              targetClass: recruit.mixin.Candidate,
              category
            })
          )
          namedElements.set(title, e)
          elements.set(e._id, e)
          newElements.push(e)
        }
        if (e !== undefined) {
          newSkills.push(
            TxProcessor.createDoc2Doc(
              client.txFactory.createTxCreateDoc(tags.class.TagReference, core.space.Workspace, {
                title: e.title,
                color: e.color,
                tag: e._id,
                attachedTo: '' as Ref<Doc>,
                attachedToClass: recruit.mixin.Candidate,
                collection: 'skills'
              })
            )
          )
        }
      }
      object.skills = [...object.skills, ...newSkills]
    } catch (err: any) {
      Analytics.handleError(err)
      console.error(err)
    }
  }

  async function deleteResume (): Promise<void> {
    if (object.resumeUuid) {
      try {
        await deleteFile(object.resumeUuid)
      } catch (err) {
        console.error(err)
      }
    }
  }

  async function createAttachment (file: File) {
    loading = true
    try {
      const uploadFile = await getResource(attachment.helper.UploadFile)

      object.resumeUuid = await uploadFile(file)
      object.resumeName = file.name
      object.resumeSize = file.size
      object.resumeType = file.type
      object.resumeLastModified = file.lastModified

      await recognize(file)
    } catch (err: any) {
      setPlatformStatus(unknownError(err))
    } finally {
      loading = false
    }
  }

  function drop (event: DragEvent) {
    dragover = false
    const droppedFile = event.dataTransfer?.files[0]
    if (droppedFile !== undefined) {
      createAttachment(droppedFile)
    }
  }

  function fileSelected () {
    const file = inputFile.files?.[0]
    if (file !== undefined) {
      createAttachment(file)
    }
    manager.setFocusPos(102)
  }

  function addTagRef (tag: TagElement): void {
    object.skills = [
      ...object.skills,
      {
        _class: tags.class.TagReference,
        _id: generateId(),
        attachedTo: '' as Ref<Doc>,
        attachedToClass: recruit.mixin.Candidate,
        collection: 'skills',
        space: core.space.Workspace,
        modifiedOn: 0,
        modifiedBy: '' as PersonId,
        title: tag.title,
        tag: tag._id,
        color: tag.color
      }
    ]
  }

  $: if (object.firstName != null && object.lastName != null) {
    void findContacts(
      client,
      contact.class.Person,
      combineName(object.firstName.trim(), object.lastName.trim()),
      object.channels
    ).then((p) => {
      matches = p.contacts
      matchedChannels = p.channels
    })
  }

  const manager = createFocusManager()

  function resetObject (): void {
    object = getEmptyCandidate()
    fillDefaults(hierarchy, object, recruit.mixin.Candidate)
  }

  export async function onOutsideClick (): Promise<void> {
    if (shouldSaveDraft) {
      draftController.save(object, empty)
    }
  }

  async function showConfirmationDialog (): Promise<void> {
    draftController.save(object, empty)
    const isFormEmpty = draft === undefined

    if (isFormEmpty) {
      dispatch('close')
    } else {
      showPopup(
        MessageBox,
        {
          label: recruit.string.CreateTalentDialogClose,
          message: recruit.string.CreateTalentDialogCloseNote,
          action: async () => {
            await deleteResume()
            resetObject()
            draftController.remove()
          }
        },
        'top',
        (result?: boolean) => {
          if (result === true) {
            dispatch('close')
          }
        }
      )
    }
  }
</script>

<FocusHandler {manager} />

<Card
  label={recruit.string.CreateTalent}
  okAction={createCandidate}
  canSave={!loading &&
    ((object.firstName?.length ?? 0) > 0 || (object.lastName?.length ?? 0) > 0 || object.channels.length > 0)}
  on:close={() => {
    dispatch('close')
  }}
  onCancel={showConfirmationDialog}
  on:changeContent
>
  <svelte:fragment slot="header">
    <Button icon={contact.icon.Person} label={contact.string.Person} size={'large'} disabled on:click={() => {}} />
  </svelte:fragment>
  <div class="flex-between">
    <div class="flex-col">
      <EditBox
        disabled={loading}
        placeholder={recruit.string.PersonFirstNamePlaceholder}
        bind:value={object.firstName}
        kind={'large-style'}
        autoFocus
        maxWidth={'30rem'}
        focusIndex={1}
      />
      <EditBox
        disabled={loading}
        placeholder={recruit.string.PersonLastNamePlaceholder}
        bind:value={object.lastName}
        maxWidth={'30rem'}
        kind={'large-style'}
        focusIndex={2}
      />
      <div class="mt-1">
        <EditBox
          disabled={loading}
          placeholder={recruit.string.Title}
          bind:value={object.title}
          kind={'small-style'}
          focusIndex={3}
          maxWidth={'30rem'}
        />
      </div>
      <EditBox
        disabled={loading}
        placeholder={recruit.string.Location}
        bind:value={object.city}
        kind={'small-style'}
        focusIndex={4}
        maxWidth={'30rem'}
      />
    </div>
    <div class="flex-col items-center flex-gap-2 ml-4">
      <EditableAvatar
        disabled={loading}
        bind:this={avatarEditor}
        bind:direct={object.avatar}
        person={{
          avatarType: AvatarType.COLOR
        }}
        size={'large'}
        name={combineName(object?.firstName?.trim() ?? '', object?.lastName?.trim() ?? '')}
      />
      <ActionIcon
        icon={IconShuffle}
        label={recruit.string.SwapFirstAndLastNames}
        size={'medium'}
        action={() => {
          const first = object.firstName
          object.firstName = object.lastName
          object.lastName = first
        }}
      />
    </div>
  </div>
  <svelte:fragment slot="pool">
    <ChannelsDropdown
      editable={!loading}
      focusIndex={10}
      bind:value={object.channels}
      highlighted={matchedChannels.map((it) => it.provider)}
      kind={'regular'}
      size={'large'}
    />
    <YesNo
      disabled={loading}
      focusIndex={100}
      label={recruit.string.Onsite}
      tooltip={recruit.string.WorkLocationPreferences}
      bind:value={object.onsite}
      kind={'regular'}
      size={'large'}
    />
    <YesNo
      disabled={loading}
      focusIndex={101}
      label={recruit.string.Remote}
      tooltip={recruit.string.WorkLocationPreferences}
      bind:value={object.remote}
      kind={'regular'}
      size={'large'}
    />
    <Component
      is={tags.component.TagsDropdownEditor}
      props={{
        disabled: loading,
        focusIndex: 102,
        items: object.skills,
        key,
        targetClass: recruit.mixin.Candidate,
        showTitle: false,
        elements,
        newElements,
        countLabel: recruit.string.NumberSkills,
        kind: 'regular',
        size: 'large'
      }}
      on:open={(evt) => {
        addTagRef(evt.detail)
      }}
      on:delete={(evt) => {
        object.skills = object.skills.filter((it) => it.tag !== evt.detail._id)
      }}
    />
    {#if object.skills.length > 0}
      <div class="antiComponent antiEmphasized w-full flex-grow mt-2">
        <Component
          is={tags.component.TagsEditor}
          props={{
            disabled: loading,
            focusIndex: 102,
            items: object.skills,
            key,
            targetClass: recruit.mixin.Candidate,
            showTitle: false,
            elements,
            newElements,
            countLabel: recruit.string.NumberSkills
          }}
          on:open={(evt) => {
            addTagRef(evt.detail)
          }}
          on:delete={(evt) => {
            object.skills = object.skills.filter((it) => it._id !== evt.detail)
          }}
          on:change={(evt) => {
            evt.detail.tag.weight = evt.detail.weight
            object.skills = object.skills
          }}
        />
      </div>
    {:else}
      <div class="flex-grow w-full" style="margin: 0" />
    {/if}
    <InlineAttributeBar
      _class={recruit.mixin.Candidate}
      {object}
      toClass={contact.class.Contact}
      {ignoreKeys}
      extraProps={{ showNavigate: false }}
      on:update={() => {
        object = object
      }}
    />
  </svelte:fragment>

  <svelte:fragment slot="footer">
    <div
      class="flex-center resume"
      class:solid={dragover || object.resumeUuid}
      on:dragover|preventDefault={() => {
        dragover = true
      }}
      on:dragleave={() => {
        dragover = false
      }}
      on:drop|preventDefault|stopPropagation={drop}
    >
      {#if loading && object.resumeUuid}
        <Button label={recruit.string.Parsing} icon={Spinner} disabled />
      {:else}
        {#if loading}
          <Button label={recruit.string.Uploading} icon={Spinner} disabled />
        {:else if object.resumeUuid}
          <Button
            disabled={loading}
            focusIndex={103}
            icon={FileIcon}
            on:click={() => {
              showPopup(
                FilePreviewPopup,
                {
                  file: object.resumeUuid,
                  contentType: object.resumeType,
                  name: object.resumeName
                },
                object.resumeType?.startsWith('image/') ? 'centered' : 'float'
              )
            }}
          >
            <svelte:fragment slot="content">
              <span class="overflow-label disabled">{object.resumeName}</span>
            </svelte:fragment>
          </Button>
        {:else}
          <Button
            focusIndex={103}
            label={recruit.string.AddDropHere}
            icon={IconAttachment}
            notSelected
            on:click={() => {
              inputFile.click()
            }}
          />
        {/if}
        <input bind:this={inputFile} type="file" name="file" id="file" style="display: none" on:change={fileSelected} />
      {/if}
      <div class="ml-1">
        <MiniToggle bind:on={shouldCreateNewSkills} label={recruit.string.CreateNewSkills} />
      </div>
    </div>
    {#if matches.length > 0}
      <div class="flex-col-stretch flex-grow error-color">
        <div class="flex mb-1">
          <IconInfo size={'medium'} />
          <span class="text-sm overflow-label ml-2">
            <Label label={contact.string.PersonAlreadyExists} />
          </span>
        </div>
        <PersonPresenter value={matches[0]} avatarSize={'tiny'} />
      </div>
    {/if}
  </svelte:fragment>
</Card>

<style lang="scss">
  .resume {
    box-shadow: 0 0 0 0 var(--primary-button-outline);
    border-radius: 0.25rem;
    transition: box-shadow 0.15s ease-in-out;

    &.solid {
      box-shadow: 0 0 0 2px var(--primary-button-outline);
    }
  }
  .skills-box {
    padding: 0.5rem 0.75rem;
    background: var(--theme-comp-header-color);
    border: 1px dashed var(--theme-divider-color);
    border-radius: 0.5rem;
  }
</style>
