import * as React from 'react';
import * as PropTypes from 'prop-types';
import {ConnectedComponent} from 'react-redux';
import {v4} from 'uuid';
import {toast, ToastContainer} from 'react-toastify';

import {addFilesAction, FileIndexReducerType, removeFileAction} from '../redux/fileIndexReducer';
import {GtoveDispatchProp} from '../redux/mainReducer';
import InputButton from '../presentation/inputButton';
import * as constants from '../util/constants';
import FileThumbnail from '../presentation/fileThumbnail';
import BreadCrumbs from '../presentation/breadCrumbs';
import {
    AnyAppProperties,
    AnyProperties,
    anyPropertiesTooLong,
    DriveMetadata,
    isTabletopFileMetadata,
    isWebLinkProperties,
} from '../util/googleDriveUtils';
import {FileAPIContext, OnProgressParams, splitFileName} from '../util/fileUtils';
import RenameFileEditor from '../presentation/renameFileEditor';
import {PromiseModalContext} from './authenticatedContainer';
import {TextureLoaderContext} from '../util/driveTextureLoader';
import {DropDownMenuClickParams, DropDownMenuOption} from '../presentation/dropDownMenu';
import Spinner from '../presentation/spinner';
import InputField from '../presentation/inputField';
import SearchBar from '../presentation/searchBar';

export type BrowseFilesCallback<A extends AnyAppProperties, B extends AnyProperties, C> = (metadata: DriveMetadata<A, B>, parameters?: DropDownMenuClickParams) => C;

export type BrowseFilesComponentGlobalAction<A extends AnyAppProperties, B extends AnyProperties> = {
    label: string;
    createsFile: boolean;
    onClick: (parents: string[]) => Promise<DriveMetadata<A, B> | undefined>;
    hidden?: boolean;
};

interface BrowseFilesComponentFileOnClickOptionalResult<A extends AnyAppProperties, B extends AnyProperties> {
    postAction: string;
    metadata: DriveMetadata<A, B>
}

export type BrowseFilesComponentFileAction<A extends AnyAppProperties, B extends AnyProperties> = {
    label: string;
    onClick: 'edit' | 'delete' | BrowseFilesCallback<A, B, void | Promise<void | BrowseFilesComponentFileOnClickOptionalResult<A, B>>>;
    disabled?: BrowseFilesCallback<A, B, boolean>;
};

interface BrowseFilesComponentProps<A extends AnyAppProperties, B extends AnyProperties> extends GtoveDispatchProp {
    files: FileIndexReducerType;
    topDirectory: string;
    folderStack: string[];
    setFolderStack: (root: string, folderStack: string[]) => void;
    fileActions: BrowseFilesComponentFileAction<A, B>[];
    fileIsNew?: BrowseFilesCallback<A, B, boolean>;
    editorComponent: React.ComponentClass<any, any> | ConnectedComponent<any, any>; // TODO shouldn't need to explicitly allow ConnectedComponent
    onBack?: () => void;
    globalActions?: BrowseFilesComponentGlobalAction<A, B>[];
    allowUploadAndWebLink: boolean;
    screenInfo?: React.ReactElement<any> | ((directory: string, fileIds: string[], loading: boolean) => React.ReactElement<any>);
    highlightMetadataId?: string;
    jsonIcon?: string | BrowseFilesCallback<A, B, React.ReactElement<any>>;
    showSearch: boolean;
}

interface BrowseFilesComponentState {
    editMetadata?: DriveMetadata;
    newFile: boolean;
    uploadProgress: {[key: string]: number};
    loading: boolean;
    uploading: boolean;
    showBusySpinner: boolean;
    searchResult?: DriveMetadata[];
    searchTerm?: string;
}

export default class BrowseFilesComponent<A extends AnyAppProperties, B extends AnyProperties> extends React.Component<BrowseFilesComponentProps<A, B>, BrowseFilesComponentState> {

    static URL_REGEX = new RegExp('^[a-z][-a-z0-9+.]*:\\/\\/(%[0-9a-f][0-9a-f]|[-a-z0-9._~!$&\'()*+,;=:])*\\/');

    static contextTypes = {
        fileAPI: PropTypes.object,
        textureLoader: PropTypes.object,
        promiseModal: PropTypes.func
    };

    context: FileAPIContext & TextureLoaderContext & PromiseModalContext;

    constructor(props: BrowseFilesComponentProps<A, B>) {
        super(props);
        this.onClickThumbnail = this.onClickThumbnail.bind(this);
        this.onUploadInput = this.onUploadInput.bind(this);
        this.onWebLinksPressed = this.onWebLinksPressed.bind(this);
        this.onPaste = this.onPaste.bind(this);
        this.showBusySpinner = this.showBusySpinner.bind(this);
        this.state = {
            editMetadata: undefined,
            newFile: false,
            uploadProgress: {},
            loading: false,
            uploading: false,
            showBusySpinner: false
        };
    }

    componentDidMount() {
        this.loadCurrentDirectoryFiles();
    }

    UNSAFE_componentWillReceiveProps(props: BrowseFilesComponentProps<A, B>) {
        if (props.folderStack.length !== this.props.folderStack.length) {
            this.loadCurrentDirectoryFiles(props);
        }
    }

    async loadCurrentDirectoryFiles(props: BrowseFilesComponentProps<A, B> = this.props) {
        const currentFolderId = props.folderStack[props.folderStack.length - 1];
        const leftBehind = (this.props.files.children[currentFolderId] || []).reduce((all, fileId) => {
            all[fileId] = true;
            return all;
        }, {});
        this.setState({loading: true});
        try {
            await this.context.fileAPI.loadFilesInFolder(currentFolderId, (files: DriveMetadata[]) => {
                props.dispatch(addFilesAction(files));
                files.forEach((metadata) => {leftBehind[metadata.id] = false});
            });
            // Clean up any files that are no longer in directory
            Object.keys(leftBehind)
                .filter((fileId) => (leftBehind[fileId]))
                .forEach((fileId) => {
                    props.dispatch(removeFileAction({id: fileId, parents: [currentFolderId]}));
                });
        } catch (err) {
            console.log('Error getting contents of current folder', err);
        }
        this.setState({loading: false});
    }

    createPlaceholderFile(name: string, parents: string[]): DriveMetadata {
        // Dispatch a placeholder file
        const placeholder: DriveMetadata = {id: v4(), name, parents, trashed: false, appProperties: undefined, properties: undefined};
        this.setState((prevState) => ({uploadProgress: {...prevState.uploadProgress, [placeholder.id]: 0}}), () => {
            this.props.dispatch(addFilesAction([placeholder]));
        });
        return placeholder;
    }

    cleanUpPlaceholderFile(placeholder: DriveMetadata, driveMetadata: DriveMetadata | null) {
        this.props.dispatch(removeFileAction(placeholder));
        if (driveMetadata) {
            this.props.dispatch(addFilesAction([driveMetadata]));
        }
        this.setState((prevState) => {
            let uploadProgress = {...prevState.uploadProgress};
            delete(uploadProgress[placeholder.id]);
            return {uploadProgress};
        });
        return driveMetadata;
    }

    uploadSingleFile(file: File, parents: string[], placeholderId: string): Promise<DriveMetadata> {
        return this.context.fileAPI
            .uploadFile({name: file.name, parents}, file, (progress: OnProgressParams) => {
                this.setState((prevState) => {
                    return {
                        uploadProgress: {
                            ...prevState.uploadProgress,
                            [placeholderId]: progress.loaded / progress.total
                        }
                    }
                });
            })
            .then((driveMetadata: DriveMetadata) => {
                return this.context.fileAPI.makeFileReadableToAll(driveMetadata)
                    .then(() => (driveMetadata));
            });
    }

    private isMetadataOwnedByMe(metadata: DriveMetadata) {
        return metadata.owners && metadata.owners.reduce((me, owner) => (me || owner.me), false)
    }

    uploadMultipleFiles(fileArray: File[]) {
        const parents = this.props.folderStack.slice(this.props.folderStack.length - 1);
        const placeholders = fileArray.map((file) => (this.createPlaceholderFile(file && file.name, parents)));
        this.setState({uploading: true}, () => {
            fileArray.reduce((promiseChain: Promise<null | DriveMetadata>, file, index): Promise<null | DriveMetadata> => (
                promiseChain
                    .then(() => ((file && this.state.uploading) ? this.uploadSingleFile(file, parents, placeholders[index].id) : Promise.resolve(null)))
                    .then((metadata: null | DriveMetadata) => (this.cleanUpPlaceholderFile(placeholders[index], metadata)))
            ), Promise.resolve(null))
                .then((driveMetadata) => {
                    if (driveMetadata && fileArray.length === 1 && this.isMetadataOwnedByMe(driveMetadata)) {
                        // For single file upload, automatically edit after creating if it's owned by me
                        this.setState({editMetadata: driveMetadata, newFile: true});
                    }
                    this.setState({uploading: false});
                });
        });
    }

    onUploadInput(event?: React.ChangeEvent<HTMLInputElement>) {
        if (event && event.target.files) {
            this.uploadMultipleFiles(Array.from(event.target.files));
        }
    }

    getFilenameFromUrl(url: string): string {
        return url.split('#').shift()!.split('?').shift()!.split('/').pop()!;
    }

    uploadWebLinks(text: string) {
        const webLinks = text.split(/\s+/)
            .filter((text) => (text.toLowerCase().match(BrowseFilesComponent.URL_REGEX)));
        if (webLinks.length > 0) {
            const parents = this.props.folderStack.slice(this.props.folderStack.length - 1);
            const placeholders = webLinks.map((link) => (this.createPlaceholderFile(this.getFilenameFromUrl(link), parents)));
            this.setState({uploading: true}, () => {
                webLinks
                    .reduce((promiseChain: Promise<null | DriveMetadata>, webLink, index) => (
                        promiseChain.then(() => {
                            const metadata: Partial<DriveMetadata> = {
                                name: this.getFilenameFromUrl(webLink),
                                parents: this.props.folderStack.slice(this.props.folderStack.length - 1),
                                properties: {webLink}
                            };
                            if (anyPropertiesTooLong(metadata.properties)) {
                                toast(`URL is too long: ${webLink}`);
                                return this.cleanUpPlaceholderFile(placeholders[index], null);
                            } else {
                                return this.context.fileAPI.uploadFileMetadata(metadata)
                                    .then((driveMetadata: DriveMetadata) => {
                                        return this.context.fileAPI.makeFileReadableToAll(driveMetadata)
                                            .then(() => (this.cleanUpPlaceholderFile(placeholders[index], driveMetadata)));
                                    })
                            }
                        })
                    ), Promise.resolve(null))
                    .then((driveMetadata) => {
                        if (driveMetadata && webLinks.length === 1 && this.isMetadataOwnedByMe(driveMetadata)) {
                            // For single file upload, automatically edit after creating if it's owned by me
                            this.setState({editMetadata: driveMetadata, newFile: true});
                        }
                        this.setState({uploading: false})
                    });
            });
        }
    }

    async onWebLinksPressed() {
        let textarea: HTMLTextAreaElement;
        if (this.context.promiseModal && !this.context.promiseModal.isBusy()) {
            const result = await this.context.promiseModal({
                className: 'webLinkModal',
                children: (
                    <textarea
                        ref={(element: HTMLTextAreaElement) => {textarea = element}}
                        placeholder='Enter the URLs of one or more images, separated by spaces.'
                    />
                ),
                options: [
                    {label: 'Create links to images', value: () => (textarea.value)},
                    {label: 'Cancel', value: null}
                ]
            });
            if (result) {
                this.uploadWebLinks(result);
            }
        }
    }

    onPaste(event: React.ClipboardEvent<HTMLDivElement>) {
        // Only support paste on pages which allow upload.
        if (this.props.allowUploadAndWebLink) {
            if (event.clipboardData.files && event.clipboardData.files.length > 0) {
                this.uploadMultipleFiles(Array.from(event.clipboardData.files));
            } else {
                this.uploadWebLinks(event.clipboardData.getData('text'));
            }
        }
    }

    async onGlobalAction(action: BrowseFilesComponentGlobalAction<A, B>) {
        const parents = this.props.folderStack.slice(this.props.folderStack.length - 1);
        const placeholder = action.createsFile ? this.createPlaceholderFile('', parents) : undefined;
        const driveMetadata = await action.onClick(parents);
        if (placeholder && driveMetadata) {
            this.cleanUpPlaceholderFile(placeholder, driveMetadata);
            if (this.isMetadataOwnedByMe(driveMetadata)) {
                this.setState({editMetadata: driveMetadata, newFile: true});
            }
        }
    }

    onEditFile(metadata: DriveMetadata) {
        this.setState({editMetadata: metadata, newFile: false});
    }

    async onDeleteFile(metadata: DriveMetadata) {
        if (this.context.promiseModal && !this.context.promiseModal.isBusy()) {
            if (metadata.id === this.props.highlightMetadataId) {
                await this.context.promiseModal({
                    children: 'Can\'t delete the currently selected file.'
                });
            } else {
                const yesOption = 'Yes';
                const response = await this.context.promiseModal({
                    children: `Are you sure you want to delete ${metadata.name}?`,
                    options: [yesOption, 'Cancel']
                });
                if (response === yesOption) {
                    this.props.dispatch(removeFileAction(metadata));
                    await this.context.fileAPI.deleteFile(metadata);
                    if (isTabletopFileMetadata(metadata)) {
                        // Also trash the private GM file.
                        await this.context.fileAPI.deleteFile({id: metadata.appProperties.gmFile});
                    }
                }
            }
        }
    }

    private showBusySpinner(show: boolean) {
        this.setState({showBusySpinner: show});
    }

    onClickThumbnail(fileId: string) {
        const metadata = this.props.files.driveMetadata[fileId] as DriveMetadata<A, B>;
        const fileMenu = this.buildFileMenu(metadata);
        // Perform the first enabled menu action
        const firstItem = fileMenu.find((menuItem) => (!menuItem.disabled));
        if (firstItem) {
            firstItem.onClick({showBusySpinner: this.showBusySpinner});
        }
    }

    async onAddFolder(prefix = ''): Promise<void> {
        const promiseModal = this.context.promiseModal;
        if (!promiseModal || promiseModal.isBusy()) {
            return;
        }
        const okResponse = 'OK';
        let name: string = 'New Folder';
        const returnAction = () => {promiseModal.setResult(okResponse)};
        const response = await promiseModal({
            options: [okResponse, 'Cancel'],
            children: (
                <div>
                    {prefix + 'Please enter the name of the new folder.'}
                    <InputField type='text' initialValue={name} select={true} focus={true}
                                specialKeys={{Return: returnAction, Enter: returnAction}}
                                onChange={(value: string) => {name = value}}
                    />
                </div>
            )
        });
        if (response === okResponse && name) {
            // Check the name is unique
            const currentFolder = this.props.folderStack[this.props.folderStack.length - 1];
            const valid = (this.props.files.children[currentFolder] || []).reduce((valid, fileId) => {
                return valid && (name.toLowerCase() !== this.props.files.driveMetadata[fileId].name.toLowerCase());
            }, true);
            if (valid) {
                this.setState({loading: true});
                const metadata = await this.context.fileAPI.createFolder(name, {parents:[currentFolder]});
                this.props.dispatch(addFilesAction([metadata]));
                this.setState({loading: false});
            } else {
                return this.onAddFolder('That name is already in use.  ');
            }
        }
    }

    buildFileMenu(metadata: DriveMetadata<A, B>): DropDownMenuOption<BrowseFilesComponentFileOnClickOptionalResult<A, B>>[] {
        const isFolder = (metadata.mimeType === constants.MIME_TYPE_DRIVE_FOLDER);
        let fileActions: BrowseFilesComponentFileAction<A, B>[] = isFolder ? [
            {label: 'Open', onClick: () => {
                this.props.setFolderStack(this.props.topDirectory, [...this.props.folderStack, metadata.id]);
            }},
            {label: 'Rename', onClick: 'edit'},
            {label: 'Delete', onClick: 'delete', disabled: () => (metadata.id === this.props.highlightMetadataId)}
        ] : this.props.fileActions;
        if (this.state.searchResult) {
            fileActions = [...fileActions, {
                label: 'View in folder',
                onClick: async () => {
                    this.setState({showBusySpinner: true});
                    // Need to build the breadcrumbs
                    const rootFolderId = this.props.files.roots[this.props.topDirectory];
                    const folderStack = [];
                    for (let folderId = metadata.parents[0]; folderId !== rootFolderId; folderId = this.props.files.driveMetadata[folderId].parents[0]) {
                        folderStack.push(folderId);
                        if (!this.props.files.driveMetadata[folderId]) {
                            this.props.dispatch(addFilesAction([await this.context.fileAPI.getFullMetadata(folderId)]));
                        }
                    }
                    folderStack.push(rootFolderId);
                    this.props.setFolderStack(this.props.topDirectory, folderStack.reverse());
                    this.setState({showBusySpinner: false, searchTerm: undefined, searchResult: undefined});
                }}];
        }
        return fileActions.map((fileAction) => {
            let disabled = fileAction.disabled ? fileAction.disabled(metadata) : false;
            let onClick;
            const fileActionOnClick = fileAction.onClick;
            if (fileActionOnClick === 'edit') {
                onClick = () => (this.onEditFile(metadata));
            } else if (fileActionOnClick === 'delete') {
                onClick = () => (this.onDeleteFile(metadata));
            } else {
                onClick = async (parameters: DropDownMenuClickParams) => {
                    const result = await fileActionOnClick(metadata, parameters);
                    if (result && result.postAction === 'edit') {
                        this.onEditFile(result.metadata);
                    }
                };
            }
            return {
                label: fileAction.label,
                disabled,
                onClick
            };
        });
    }

    renderFileThumbnail(metadata: DriveMetadata<A, B>) {
        const isFolder = (metadata.mimeType === constants.MIME_TYPE_DRIVE_FOLDER);
        const isJson = (metadata.mimeType === constants.MIME_TYPE_JSON);
        const name = (metadata.appProperties || metadata.properties) ? splitFileName(metadata.name).name : metadata.name;
        const menuOptions = this.buildFileMenu(metadata);
        return (
            <FileThumbnail
                key={metadata.id}
                fileId={metadata.id}
                name={name}
                isFolder={isFolder}
                isIcon={isJson}
                isNew={this.props.fileIsNew ? (!isFolder && !isJson && this.props.fileIsNew(metadata)) : false}
                progress={this.state.uploadProgress[metadata.id] || 0}
                thumbnailLink={isWebLinkProperties(metadata.properties) ? metadata.properties.webLink : metadata.thumbnailLink}
                onClick={this.onClickThumbnail}
                highlight={this.props.highlightMetadataId === metadata.id}
                menuOptions={menuOptions}
                icon={(typeof(this.props.jsonIcon) === 'function') ? this.props.jsonIcon(metadata) : this.props.jsonIcon}
                showBusySpinner={this.showBusySpinner}
            />
        );
    }

    renderSearchResults() {
        const searchResult = this.state.searchResult!;
        return (
            <div>
                {
                    searchResult.length === 0 ? (
                        <p>
                            No matching results found.  Note that the search will not find files which are marked as
                            <span className='material-icons' style={{color: 'green'}}>fiber_new</span>.
                        </p>
                    ) : (
                        searchResult.map((file) => (this.renderFileThumbnail(file as DriveMetadata<A, B>)))
                    )
                }
            </div>
        );
    }

    renderThumbnails(currentFolder: string) {
        let sorted = (this.props.files.children[currentFolder] || []).sort((id1, id2) => {
            const file1 = this.props.files.driveMetadata[id1];
            const file2 = this.props.files.driveMetadata[id2];
            const isFolder1 = (file1.mimeType === constants.MIME_TYPE_DRIVE_FOLDER);
            const isFolder2 = (file2.mimeType === constants.MIME_TYPE_DRIVE_FOLDER);
            if (isFolder1 && !isFolder2) {
                return -1;
            } else if (!isFolder1 && isFolder2) {
                return 1;
            } else {
                return file1.name < file2.name ? -1 : (file1.name === file2.name ? 0 : 1);
            }
        });
        const folderDepth = this.props.folderStack.length;
        return (
            <div>
                {
                    folderDepth === 1 ? null : (
                        <FileThumbnail
                            fileId={this.props.folderStack[folderDepth - 2]}
                            name={this.props.files.driveMetadata[this.props.folderStack[folderDepth - 2]].name}
                            isFolder={false}
                            isIcon={true}
                            icon='arrow_back'
                            isNew={false}
                            onClick={() => {
                                this.props.setFolderStack(this.props.topDirectory, this.props.folderStack.slice(0, folderDepth - 1));
                            }}
                            showBusySpinner={this.showBusySpinner}
                        />
                    )
                }
                {
                    sorted.map((fileId: string) => (
                        this.renderFileThumbnail(this.props.files.driveMetadata[fileId] as DriveMetadata<A, B>)
                    ))
                }
                {
                    !this.state.uploading ? null : (
                        <InputButton type='button' onChange={() => {this.setState({uploading: false})}}>Cancel uploads</InputButton>
                    )
                }
                {
                    !this.state.loading ? null : (
                        <div className='fileThumbnail'><Spinner size={60}/></div>
                    )
                }
                {
                    !this.props.screenInfo ? null :
                        typeof(this.props.screenInfo) === 'function' ? this.props.screenInfo(currentFolder, sorted, this.state.loading) : this.props.screenInfo
                }
            </div>
        );
    }

    renderBrowseFiles() {
        return (
            <div className='fullHeight' onPaste={this.onPaste}>
                {
                    !this.props.onBack ? null : (
                        <InputButton type='button' onChange={this.props.onBack}>Finish</InputButton>
                    )
                }
                {
                    !this.state.searchResult ? null : (
                        <InputButton type='button' onChange={() => {this.setState({searchResult: undefined, searchTerm: undefined})}}>Clear Search</InputButton>
                    )
                }
                {
                    this.state.searchResult || !this.props.allowUploadAndWebLink ? null : (
                        <InputButton type='file' multiple={true} onChange={this.onUploadInput}>Upload</InputButton>
                    )
                }
                {
                    this.state.searchResult || !this.props.allowUploadAndWebLink ? null : (
                        <InputButton type='button' onChange={this.onWebLinksPressed}>Link to Images</InputButton>
                    )
                }
                {
                    this.state.searchResult || !this.props.globalActions ? null : (
                        this.props.globalActions
                            .filter((action) => (!action.hidden))
                            .map((action) => (
                                <InputButton type='button' key={action.label} onChange={() => (this.onGlobalAction(action))}>{action.label}</InputButton>
                            ))
                    )
                }
                {
                    this.state.searchResult ? null : (
                        <InputButton type='button' onChange={() => this.onAddFolder()}>Add Folder</InputButton>
                    )
                }
                {
                    this.state.searchResult ? null : (
                        <InputButton type='button' onChange={() => this.loadCurrentDirectoryFiles()}>Refresh</InputButton>
                    )
                }
                {
                    !this.props.showSearch ? null : (
                        <SearchBar placeholder={'Search all ' + this.props.topDirectory}
                                   initialValue={this.state.searchTerm || ''}
                                   onSearch={async (searchTerm) => {
                                       if (searchTerm) {
                                           this.setState({showBusySpinner: true});
                                           const matches = await this.context.fileAPI.findFilesContainingNameWithProperty(searchTerm, 'rootFolder', this.props.topDirectory);
                                           this.setState({showBusySpinner: false});
                                           matches.sort((f1, f2) => (f1.name < f2.name ? -1 : f1.name > f2.name ? 1 : 0));
                                           this.setState({searchResult: matches, searchTerm});
                                       } else {
                                           this.setState({searchResult: undefined, searchTerm: undefined});
                                       }
                                   }}
                        />
                    )
                }
                {
                    this.state.searchResult ? (
                        <div>{this.props.topDirectory} with names matching "{this.state.searchTerm}"</div>
                    ) : (
                        <BreadCrumbs folders={this.props.folderStack} files={this.props.files} onChange={(folderStack: string[]) => {
                            this.props.setFolderStack(this.props.topDirectory, folderStack);
                        }}/>
                    )
                }
                {
                    this.state.searchResult ? this.renderSearchResults() : this.renderThumbnails(this.props.folderStack[this.props.folderStack.length - 1])
                }
                <ToastContainer className='toastContainer' position={toast.POSITION.BOTTOM_CENTER} hideProgressBar={true}/>
            </div>
        );
    }

    render() {
        if (this.state.editMetadata) {
            const Editor = (this.state.editMetadata.mimeType === constants.MIME_TYPE_DRIVE_FOLDER) ? RenameFileEditor : this.props.editorComponent;
            return (
                <Editor
                    metadata={this.state.editMetadata}
                    onClose={() => {this.setState({editMetadata: undefined, newFile: false})}}
                    textureLoader={this.context.textureLoader}
                    newFile={this.state.newFile}
                />
            );
        } else if (this.state.showBusySpinner) {
            return (
                <div className='fileThumbnail'><Spinner size={60}/></div>
            );
        } else {
            return this.renderBrowseFiles();
        }
    }

}
