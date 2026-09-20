// Initialize all application features on startup

import { init as initProjectPicker } from './projectPicker.js';
import { init as initProjectDetails } from './projectDetails.js';
import { init as initSubjectConfigurator } from './subjectConfigurator.js';
import { init as initUploadArchive } from './uploadArchive.js';
import { init as initCreateProject } from './createProject.js';
import { init as initCreateProjectMode } from './createProjectMode.js';
import { init as initUploadProject } from './uploadProject.js';
import { init as initAddData } from './addData.js';
import { init as initDataGuidelines } from './dataGuidelines.js';
import { init as initExportModal } from './exportModal.js';
import { init as initChartScreenshotExport } from './chartScreenshotExport.js';
import { init as initArrays } from './arrays.js';
import { init as initVisibilityEditor } from './visibilityEditor.js';
import { init as initArrayRename } from './arrayRename.js';
import { init as initColumnNames } from './columnNames.js';
import { init as initDangerousActions } from './dangerousActions.js';
import { init as initCards } from './cards.js';
import { init as initCardConfigurator } from './cardConfigurator.js';
import { init as initSheets } from './sheets.js';
import { init as initInteractionMode } from './interactionMode.js';
import { init as initTimeControls } from './timeControls.js';
import { init as initTimeRangeIndicator } from './timeRangeIndicator.js';
import { init as initSelectionIndicator } from './selectionIndicator.js';
import { init as initClusterIndicator } from './clusterIndicator.js';
import { init as initExploreToolPalette } from './exploreToolPalette.js';
import { init as initTemporalFocusModal } from './timeControls/temporalFocusModal.js';
import { init as initSubjectSelector } from './subjectSelector.js';
import { initConfirmationModal } from '../ui/confirm.js';
import { initWorkspaceGrid } from '../ui/workspaceGrid.js';

export function bootstrap() {
  console.log('[Bootstrap] Application initialization started.');

  initConfirmationModal();
  initWorkspaceGrid();

  const featureInitializers = [
    { name: 'interactionMode', init: initInteractionMode },
    { name: 'projectPicker', init: initProjectPicker },
    { name: 'projectDetails', init: initProjectDetails },
    { name: 'subjectConfigurator', init: initSubjectConfigurator },
    { name: 'uploadArchive', init: initUploadArchive },
    { name: 'createProject', init: initCreateProject },
    { name: 'createProjectMode', init: initCreateProjectMode },
    { name: 'uploadProject', init: initUploadProject },
    { name: 'addData', init: initAddData },
    { name: 'dataGuidelines', init: initDataGuidelines },
    { name: 'exportModal', init: initExportModal },
    { name: 'chartScreenshotExport', init: initChartScreenshotExport },
    { name: 'arrays', init: initArrays },
    { name: 'visibilityEditor', init: initVisibilityEditor },
    { name: 'arrayRename', init: initArrayRename },
    { name: 'columnNames', init: initColumnNames },
    { name: 'dangerousActions', init: initDangerousActions },
    { name: 'cards', init: initCards },
    { name: 'cardConfigurator', init: initCardConfigurator },
    { name: 'sheets', init: initSheets },
    { name: 'timeRangeIndicator', init: initTimeRangeIndicator },
    { name: 'selectionIndicator', init: initSelectionIndicator },
    { name: 'clusterIndicator', init: initClusterIndicator },
    { name: 'timeControls', init: initTimeControls },
    { name: 'temporalFocusModal', init: initTemporalFocusModal },
    { name: 'subjectSelector', init: initSubjectSelector },
    { name: 'exploreToolPalette', init: initExploreToolPalette },
  ];

  featureInitializers.forEach(({ name, init }) => {
    console.log(`[Bootstrap] Initializing feature: ${name}`);
    init();
  });

  console.log('[Bootstrap] Application initialization complete.');
}
