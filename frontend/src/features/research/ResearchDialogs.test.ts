// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref, type PropType, type Ref } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { EditorTarget } from '@/shared/workspace';
import ResearchDialogs from './ResearchDialogs.vue';

const state = vi.hoisted(() => ({
  workspace: null as { editor: Ref<EditorTarget | null> } | null,
  dirty: true,
  saving: false,
  busy: false,
  finish: vi.fn<() => Promise<boolean>>(),
}));

vi.mock('@/shared/workspace', () => ({ useWorkspace: () => state.workspace }));

// These mock the modules behind the real defineAsyncComponent loaders. The
// parent dialog and its watch/close/unload lifecycle remain mounted and real.
function makeEditor(kind: string) {
  return defineComponent({
    name: `Test${kind}Editor`,
    props: { stock: { type: Object as PropType<{ code: string }>, required: true } },
    setup(props, { expose }) {
      expose({
        finish: () => state.finish(),
        get dirty() {
          return state.dirty;
        },
        get saving() {
          return state.saving;
        },
        get busy() {
          return state.busy;
        },
      });
      return () => h('div', { 'data-editor': kind }, props.stock.code);
    },
  });
}

vi.mock('./NotesEditor.vue', () => ({ __esModule: true, default: makeEditor('note') }));
vi.mock('./TagsEditor.vue', () => ({ __esModule: true, default: makeEditor('tags') }));
vi.mock('./ShareholdersPanel.vue', () => ({
  __esModule: true,
  default: makeEditor('shareholders'),
}));

const DialogStub = defineComponent({
  name: 'ElDialog',
  props: { modelValue: Boolean, title: { type: String, default: '' } },
  emits: ['update:modelValue'],
  setup(props, { slots, emit }) {
    return () =>
      props.modelValue
        ? h('section', { role: 'dialog' }, [
            h('h2', props.title),
            h(
              'button',
              { 'data-close': '', onClick: () => emit('update:modelValue', false) },
              '关闭弹窗',
            ),
            slots.default?.(),
            h('footer', slots.footer?.()),
          ])
        : null;
  },
});
const ButtonStub = defineComponent({
  name: 'ElButton',
  inheritAttrs: false,
  props: { disabled: Boolean, loading: Boolean },
  emits: ['click'],
  setup(props, { slots, emit }) {
    return () =>
      h('button', { disabled: props.disabled, onClick: () => emit('click') }, slots.default?.());
  },
});

let wrapper: VueWrapper | undefined;
async function settle() {
  await vi.dynamicImportSettled();
  await flushPromises();
  await nextTick();
}
async function open(kind: EditorTarget['kind'] = 'note') {
  const editor = ref<EditorTarget | null>({ kind, stock: { code: '000001', name: '样本股票' } });
  state.workspace = { editor };
  wrapper = mount(ResearchDialogs, {
    global: { stubs: { ElDialog: DialogStub, ElButton: ButtonStub } },
  });
  await settle();
  return { wrapper, editor };
}
beforeEach(() => {
  state.dirty = true;
  state.saving = false;
  state.busy = false;
  state.finish.mockReset().mockResolvedValue(false);
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.restoreAllMocks();
});

describe('research dialog lifecycle with asynchronously loaded editors', () => {
  it('retains the displayed stock and restores workspace.editor when dirty finish refuses a close', async () => {
    const { wrapper, editor } = await open();
    const accepted = editor.value;
    expect(wrapper.get('[data-editor="note"]').text()).toBe('000001');
    await wrapper.get('[data-close]').trigger('click');
    await settle();
    expect(state.finish).toHaveBeenCalledTimes(1);
    expect(editor.value).toBe(accepted);
    expect(wrapper.get('[role="dialog"]').text()).toContain('股票备注 · 样本股票');
    expect(wrapper.get('[data-editor="note"]').text()).toBe('000001');
  });

  it('allows a successful finish to close and unmount the editor', async () => {
    state.finish.mockResolvedValue(true);
    const { wrapper, editor } = await open();
    const close = wrapper.findAll('footer button').find((button) => button.text() === '保存并关闭');
    expect(close).toBeDefined();
    await close!.trigger('click');
    await settle();
    expect(state.finish).toHaveBeenCalledTimes(1);
    expect(editor.value).toBeNull();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(wrapper.find('[data-editor]').exists()).toBe(false);
  });

  it('guards replacement by another asynchronously loaded editor before accepting its stock', async () => {
    const { wrapper, editor } = await open();
    const accepted = editor.value;
    editor.value = { kind: 'tags', stock: { code: '000002', name: '另一股票' } };
    await settle();
    expect(editor.value).toBe(accepted);
    expect(wrapper.find('[data-editor="tags"]').exists()).toBe(false);
    expect(wrapper.get('[data-editor="note"]').text()).toBe('000001');

    state.finish.mockResolvedValue(true);
    editor.value = { kind: 'tags', stock: { code: '000002', name: '另一股票' } };
    await settle();
    expect(wrapper.get('[data-editor="tags"]').text()).toBe('000002');
    expect(wrapper.find('[data-editor="note"]').exists()).toBe(false);
    expect(editor.value?.kind).toBe('tags');
  });

  it.each([
    { dirty: true, saving: false, busy: false, protected: true },
    { dirty: false, saving: true, busy: false, protected: true },
    { dirty: false, saving: false, busy: true, protected: true },
    { dirty: false, saving: false, busy: false, protected: false },
  ])('beforeunload protection follows editor state $dirty/$saving/$busy', async (flags) => {
    state.dirty = flags.dirty;
    state.saving = flags.saving;
    state.busy = flags.busy;
    await open();
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(flags.protected);
    expect(state.finish).not.toHaveBeenCalled();
  });

  it('removes the same beforeunload listener on unmount and leaves no stale protection', async () => {
    const add = vi.spyOn(window, 'addEventListener'),
      remove = vi.spyOn(window, 'removeEventListener');
    const { wrapper: mounted } = await open('shareholders');
    const registration = add.mock.calls.find(([event]) => event === 'beforeunload');
    expect(registration).toBeDefined();
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    mounted.unmount();
    wrapper = undefined;
    expect(remove).toHaveBeenCalledWith('beforeunload', registration![1]);
    const afterUnmount = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(afterUnmount);
    expect(afterUnmount.defaultPrevented).toBe(false);
  });
});
