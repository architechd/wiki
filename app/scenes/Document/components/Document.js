// @flow
import { debounce } from "lodash";
import { observable } from "mobx";
import { observer, inject } from "mobx-react";
import { InputIcon } from "outline-icons";
import * as React from "react";
import keydown from "react-keydown";
import { Prompt, Route, withRouter } from "react-router-dom";
import type { Location, RouterHistory, Match } from "react-router-dom";
import styled, { withTheme } from "styled-components";
import breakpoint from "styled-components-breakpoint";

import AuthStore from "stores/AuthStore";
import UiStore from "stores/UiStore";
import Document from "models/Document";
import Revision from "models/Revision";
import Branding from "components/Branding";
import ErrorBoundary from "components/ErrorBoundary";
import Flex from "components/Flex";
import LoadingIndicator from "components/LoadingIndicator";
import Notice from "components/Notice";
import PageTitle from "components/PageTitle";
import Time from "components/Time";
import Container from "./Container";
import Contents from "./Contents";
import DocumentMove from "./DocumentMove";
import Header from "./Header";
import KeyboardShortcutsButton from "./KeyboardShortcutsButton";
import Loading from "./Loading";
import MarkAsViewed from "./MarkAsViewed";
import References from "./References";
import { emojiToUrl } from "utils/emoji";
import {
  collectionUrl,
  documentMoveUrl,
  documentHistoryUrl,
  editDocumentUrl,
  documentUrl,
} from "utils/routeHelpers";

let EditorImport;
const AUTOSAVE_DELAY = 3000;
const IS_DIRTY_DELAY = 500;
const DISCARD_CHANGES = `
You have unsaved changes.
Are you sure you want to discard them?
`;
const UPLOADING_WARNING = `
Images are still uploading.
Are you sure you want to discard them?
`;

type Props = {
  match: Match,
  history: RouterHistory,
  location: Location,
  abilities: Object,
  document: Document,
  revision: Revision,
  readOnly: boolean,
  onCreateLink: (title: string) => string,
  onSearchLink: (term: string) => any,
  theme: Object,
  auth: AuthStore,
  ui: UiStore,
};

@observer
class DocumentScene extends React.Component<Props> {
  @observable editor: ?any;
  @observable editorComponent = EditorImport;
  @observable isUploading: boolean = false;
  @observable isSaving: boolean = false;
  @observable isPublishing: boolean = false;
  @observable isDirty: boolean = false;
  @observable isEmpty: boolean = true;
  @observable moveModalOpen: boolean = false;
  @observable lastRevision: number;
  @observable title: string;
  getEditorText: () => string = () => this.props.document.text;

  constructor(props) {
    super();
    this.title = props.document.title;
    this.lastRevision = props.document.revision;
    this.loadEditor();
  }

  componentDidMount() {
    this.updateIsDirty();
    this.updateBackground();
  }

  componentDidUpdate(prevProps) {
    const { auth, document } = this.props;

    if (this.props.readOnly) {
      this.lastRevision = document.revision;
    } else if (prevProps.document.revision !== this.lastRevision) {
      if (auth.user && document.updatedBy.id !== auth.user.id) {
        this.props.ui.showToast(
          `Document updated by ${document.updatedBy.name}`,
          {
            timeout: 30 * 1000,
            action: {
              text: "Reload",
              onClick: () => {
                window.location.href = documentUrl(document);
              },
            },
          }
        );
      }
    }

    if (document.injectTemplate) {
      this.isDirty = true;
      this.title = document.title;
      document.injectTemplate = false;
    }

    this.updateBackground();
  }

  updateBackground() {
    // ensure the wider page color always matches the theme. This is to
    // account for share links which don't sit in the wider Layout component
    window.document.body.style.background = this.props.theme.background;
  }

  @keydown("m")
  goToMove(ev) {
    if (!this.props.readOnly) return;

    ev.preventDefault();
    const { document, abilities } = this.props;

    if (abilities.update) {
      this.props.history.push(documentMoveUrl(document));
    }
  }

  @keydown("e")
  goToEdit(ev) {
    if (!this.props.readOnly) return;

    ev.preventDefault();
    const { document, abilities } = this.props;

    if (abilities.update) {
      this.props.history.push(editDocumentUrl(document));
    }
  }

  @keydown("esc")
  goBack(ev) {
    if (this.props.readOnly) return;

    ev.preventDefault();
    this.props.history.goBack();
  }

  @keydown("h")
  goToHistory(ev) {
    if (!this.props.readOnly) return;

    ev.preventDefault();
    const { document, revision } = this.props;

    if (revision) {
      this.props.history.push(document.url);
    } else {
      this.props.history.push(documentHistoryUrl(document));
    }
  }

  @keydown("meta+shift+p")
  onPublish(ev) {
    ev.preventDefault();
    const { document } = this.props;
    if (document.publishedAt) return;
    this.onSave({ publish: true, done: true });
  }

  @keydown("meta+ctrl+h")
  onToggleTableOfContents(ev) {
    if (!this.props.readOnly) return;

    ev.preventDefault();
    const { ui } = this.props;

    if (ui.tocVisible) {
      ui.hideTableOfContents();
    } else {
      ui.showTableOfContents();
    }
  }

  loadEditor = async () => {
    if (this.editorComponent) return;

    try {
      const EditorImport = await import("./Editor");
      this.editorComponent = EditorImport.default;
    } catch (err) {
      console.error(err);

      // If the editor bundle fails to load then reload the entire window. This
      // can happen if a deploy happens between the user loading the initial JS
      // bundle and the async-loaded editor JS bundle as the hash will change.
      window.location.reload();
    }
  };

  handleCloseMoveModal = () => (this.moveModalOpen = false);
  handleOpenMoveModal = () => (this.moveModalOpen = true);

  onSave = async (
    options: {
      done?: boolean,
      publish?: boolean,
      autosave?: boolean,
    } = {}
  ) => {
    const { document } = this.props;

    // prevent saves when we are already saving
    if (document.isSaving) return;

    // get the latest version of the editor text value
    const text = this.getEditorText ? this.getEditorText() : document.text;
    const title = this.title;

    // prevent save before anything has been written (single hash is empty doc)
    if (text.trim() === "" && title.trim === "") return;

    // prevent autosave if nothing has changed
    if (
      options.autosave &&
      document.text.trim() === text.trim() &&
      document.title.trim() === title.trim()
    )
      return;

    document.title = title;
    document.text = text;

    let isNew = !document.id;
    this.isSaving = true;
    this.isPublishing = !!options.publish;

    try {
      const savedDocument = await document.save({
        ...options,
        lastRevision: this.lastRevision,
      });
      this.isDirty = false;
      this.lastRevision = savedDocument.revision;

      if (options.done) {
        this.props.history.push(savedDocument.url);
        this.props.ui.setActiveDocument(savedDocument);
      } else if (isNew) {
        this.props.history.push(editDocumentUrl(savedDocument));
        this.props.ui.setActiveDocument(savedDocument);
      }
    } catch (err) {
      this.props.ui.showToast(err.message);
    } finally {
      this.isSaving = false;
      this.isPublishing = false;
    }
  };

  autosave = debounce(() => {
    this.onSave({ done: false, autosave: true });
  }, AUTOSAVE_DELAY);

  updateIsDirty = () => {
    const { document } = this.props;
    const editorText = this.getEditorText().trim();
    const titleChanged = this.title !== document.title;
    const bodyChanged = editorText !== document.text.trim();

    // a single hash is a doc with just an empty title
    this.isEmpty = (!editorText || editorText === "#") && !this.title;
    this.isDirty = bodyChanged || titleChanged;
  };

  updateIsDirtyDebounced = debounce(this.updateIsDirty, IS_DIRTY_DELAY);

  onImageUploadStart = () => {
    this.isUploading = true;
  };

  onImageUploadStop = () => {
    this.isUploading = false;
  };

  onChange = (getEditorText) => {
    this.getEditorText = getEditorText;

    // document change while read only is presumed to be a checkbox edit,
    // in that case we don't delay in saving for a better user experience.
    if (this.props.readOnly) {
      this.updateIsDirty();
      this.onSave({ done: false, autosave: true });
    } else {
      this.updateIsDirtyDebounced();
      this.autosave();
    }
  };

  onChangeTitle = (event) => {
    this.title = event.target.value;
    this.updateIsDirtyDebounced();
    this.autosave();
  };

  goBack = () => {
    let url;
    if (this.props.document.url) {
      url = this.props.document.url;
    } else if (this.props.match.params.id) {
      url = collectionUrl(this.props.match.params.id);
    }
    if (url) {
      this.props.history.push(url);
    }
  };

  render() {
    const {
      document,
      revision,
      readOnly,
      location,
      abilities,
      auth,
      ui,
      match,
    } = this.props;
    const team = auth.team;
    const Editor = this.editorComponent;
    const isShare = !!match.params.shareId;

    if (!Editor) {
      return <Loading location={location} />;
    }

    const value = revision ? revision.text : document.text;
    const injectTemplate = document.injectTemplate;
    const disableEmbeds =
      (team && team.documentEmbeds === false) || document.embedsDisabled;

    return (
      <ErrorBoundary>
        <Background
          key={revision ? revision.id : document.id}
          isShare={isShare}
          column
          auto
        >
          <Route
            path={`${match.url}/move`}
            component={() => (
              <DocumentMove document={document} onRequestClose={this.goBack} />
            )}
          />
          <PageTitle
            title={document.titleWithDefault.replace(document.emoji, "")}
            favicon={document.emoji ? emojiToUrl(document.emoji) : undefined}
          />
          {(this.isUploading || this.isSaving) && <LoadingIndicator />}

          <Container justify="center" column auto>
            {!readOnly && (
              <React.Fragment>
                <Prompt
                  when={this.isDirty && !this.isUploading}
                  message={DISCARD_CHANGES}
                />
                <Prompt
                  when={this.isUploading && !this.isDirty}
                  message={UPLOADING_WARNING}
                />
              </React.Fragment>
            )}
            {!isShare && (
              <Header
                document={document}
                isRevision={!!revision}
                isDraft={document.isDraft}
                isEditing={!readOnly}
                isSaving={this.isSaving}
                isPublishing={this.isPublishing}
                publishingIsDisabled={
                  document.isSaving || this.isPublishing || this.isEmpty
                }
                savingIsDisabled={document.isSaving || this.isEmpty}
                goBack={this.goBack}
                onSave={this.onSave}
              />
            )}
            <MaxWidth
              archived={document.isArchived}
              tocVisible={ui.tocVisible}
              column
              auto
            >
              {document.isTemplate && !readOnly && (
                <Notice muted>
                  You’re editing a template. Highlight some text and use the{" "}
                  <PlaceholderIcon color="currentColor" /> control to add
                  placeholders that can be filled out when creating new
                  documents from this template.
                </Notice>
              )}
              {document.archivedAt && !document.deletedAt && (
                <Notice muted>
                  Archived by {document.updatedBy.name}{" "}
                  <Time dateTime={document.archivedAt} /> ago
                </Notice>
              )}
              {document.deletedAt && (
                <Notice muted>
                  Deleted by {document.updatedBy.name}{" "}
                  <Time dateTime={document.deletedAt} /> ago
                  {document.permanentlyDeletedAt && (
                    <React.Fragment>
                      <br />
                      This {document.noun} will be permanently deleted in{" "}
                      <Time dateTime={document.permanentlyDeletedAt} /> unless
                      restored.
                    </React.Fragment>
                  )}
                </Notice>
              )}
              <Flex auto={!readOnly}>
                {ui.tocVisible && readOnly && (
                  <Contents
                    headings={this.editor ? this.editor.getHeadings() : []}
                  />
                )}
                <Editor
                  id={document.id}
                  ref={(ref) => {
                    if (ref) {
                      this.editor = ref;
                    }
                  }}
                  isShare={isShare}
                  isDraft={document.isDraft}
                  template={document.isTemplate}
                  key={[injectTemplate, disableEmbeds].join("-")}
                  title={revision ? revision.title : this.title}
                  document={document}
                  value={readOnly ? value : undefined}
                  defaultValue={value}
                  disableEmbeds={disableEmbeds}
                  onImageUploadStart={this.onImageUploadStart}
                  onImageUploadStop={this.onImageUploadStop}
                  onSearchLink={this.props.onSearchLink}
                  onCreateLink={this.props.onCreateLink}
                  onChangeTitle={this.onChangeTitle}
                  onChange={this.onChange}
                  onSave={this.onSave}
                  onPublish={this.onPublish}
                  onCancel={this.goBack}
                  readOnly={readOnly}
                  readOnlyWriteCheckboxes={readOnly && abilities.update}
                  ui={this.props.ui}
                />
              </Flex>
              {readOnly && !isShare && !revision && (
                <React.Fragment>
                  <MarkAsViewed document={document} />
                  <ReferencesWrapper isOnlyTitle={document.isOnlyTitle}>
                    <References document={document} />
                  </ReferencesWrapper>
                </React.Fragment>
              )}
            </MaxWidth>
          </Container>
        </Background>
        {isShare ? <Branding /> : <KeyboardShortcutsButton />}
      </ErrorBoundary>
    );
  }
}

const PlaceholderIcon = styled(InputIcon)`
  position: relative;
  top: 6px;
`;

const Background = styled(Container)`
  background: ${(props) => props.theme.background};
  transition: ${(props) => props.theme.backgroundTransition};
`;

const ReferencesWrapper = styled("div")`
  margin-top: ${(props) => (props.isOnlyTitle ? -45 : 16)}px;

  @media print {
    display: none;
  }
`;

const MaxWidth = styled(Flex)`
  ${(props) =>
    props.archived && `* { color: ${props.theme.textSecondary} !important; } `};
  padding: 0 16px;
  max-width: 100vw;
  width: 100%;

  ${breakpoint("tablet")`	
    padding: 0 24px;
    margin: 4px auto 12px;
    max-width: calc(48px + ${(props) => (props.tocVisible ? "64em" : "46em")});
  `};

  ${breakpoint("desktopLarge")`
    max-width: calc(48px + 46em);
  `};
`;

export default withRouter(
  inject("ui", "auth", "policies", "revisions")(withTheme(DocumentScene))
);
