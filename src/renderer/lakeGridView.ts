type GridRow = Record<string, unknown>;
type ColumnType = 'boolean' | 'date' | 'integer' | 'number' | 'object' | 'string';
type SortDirection = 'ascending' | 'descending';
type FilterOperator = 'after' | 'before' | 'contains' | 'empty' | 'equals' | 'greater' |
  'greaterOrEqual' | 'less' | 'lessOrEqual' | 'notContains' | 'notEmpty' | 'notEquals' |
  'on' | 'startsWith';
type ColumnFormat = 'auto' | 'date' | 'datetime' | 'fixed2' | 'json' | 'locale' |
  'lowercase' | 'percent' | 'raw' | 'uppercase' | 'yesNo';
type IconName = 'chevronDown' | 'columns' | 'copy' | 'density' | 'download' | 'filter' |
  'format' | 'hide' | 'more' | 'pin' | 'search' | 'sort' | 'sortAscending' | 'sortDescending';

interface GridColumn {
  key: string;
  label: string;
  type: ColumnType;
  width: number;
}

interface SortState {
  key: string;
  direction: SortDirection;
}

interface ColumnFilter {
  operator: FilterOperator;
  value: string;
}

interface GridPosition {
  row: number;
  column: number;
}

interface FormatOption {
  value: ColumnFormat;
  label: string;
}

interface OperatorOption {
  value: FilterOperator;
  label: string;
}

const compactRowHeight = 28;
const comfortableRowHeight = 36;
const virtualOverscan = 10;
const menuCompletionHandlers = new WeakMap<HTMLElement, () => void>();

/**
 * Renders a dense, interactive data grid inspired by Databricks result tables.
 */
export function renderLakeGrid(container: HTMLElement, sourceData: unknown[]) {
  const rows = normalizeRows(sourceData);
  const columns = createColumns(rows);
  const visibleColumns = new Set(columns.map(column => column.key));
  const pinnedColumns = new Set<string>();
  const columnFilters = new Map<string, ColumnFilter>();
  const columnFormats = new Map<string, ColumnFormat>();
  let activeRows: GridRow[] = [];
  let searchQuery = '';
  let sort: SortState | undefined;
  let filtersVisible = false;
  let searchVisible = false;
  let selectionAnchor: GridPosition | undefined;
  let selectionFocus: GridPosition | undefined;
  let pointerSelecting = false;
  let draggedColumnKey: string | undefined;
  let activeMenu: HTMLDivElement | undefined;
  let activeMenuHeader: HTMLTableCellElement | undefined;
  let activeMenuPointerDismiss: ((event: PointerEvent) => void) | undefined;
  let activeMenuKeyDismiss: ((event: KeyboardEvent) => void) | undefined;
  let renderedStart = -1;
  let renderedEnd = -1;
  let scrollFrame = 0;

  container.replaceChildren();
  container.classList.add('lake-grid');

  const toolbar = createElement('div', 'lake-grid__toolbar');
  const viewLabel = createElement('button', 'lake-grid__view-label');
  viewLabel.type = 'button';
  viewLabel.title = 'Table view';
  viewLabel.append(createElement('span', '', 'Table'), createSvgIcon('chevronDown'));

  const toolbarSpacer = createElement('div', 'lake-grid__toolbar-spacer');
  const searchBox = createElement('label', 'lake-grid__search-box');
  searchBox.hidden = true;
  searchBox.appendChild(createElement('span', 'lake-grid__sr-only', 'Search all columns'));
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.placeholder = 'Search table';
  searchInput.autocomplete = 'off';
  searchBox.appendChild(searchInput);

  const searchButton = iconButton('search', 'Search table');
  const filterButton = iconButton('filter', 'Filter columns');
  const columnsButton = iconButton('columns', 'Choose columns');
  const densityButton = iconButton('density', 'Toggle compact rows');
  const copyButton = iconButton('copy', 'Copy selected cells');
  copyButton.disabled = true;
  const columnsPanel = createElement('div', 'lake-grid__columns-panel');
  columnsPanel.hidden = true;

  toolbar.append(
    viewLabel,
    toolbarSpacer,
    searchBox,
    searchButton,
    filterButton,
    columnsButton,
    densityButton,
    copyButton
  );

  const scroller = createElement('div', 'lake-grid__scroller');
  scroller.tabIndex = 0;
  scroller.setAttribute('role', 'region');
  scroller.setAttribute('aria-label', 'Data table');
  const table = document.createElement('table');
  table.className = 'lake-grid__table';
  table.setAttribute('aria-label', 'Notebook result data');
  const head = document.createElement('thead');
  const body = document.createElement('tbody');
  table.append(head, body);
  scroller.appendChild(table);

  const footer = createElement('div', 'lake-grid__footer');
  const downloadButton = iconButton('download', 'Download filtered rows as CSV');
  downloadButton.classList.add('lake-grid__download');
  const footerCount = createElement('span', 'lake-grid__row-count');
  const selectionInfo = createElement('span', 'lake-grid__selection-info');
  const footerSpacer = createElement('span', 'lake-grid__footer-spacer');
  const viewportInfo = createElement('span', 'lake-grid__viewport-info');
  footer.append(downloadButton, footerCount, selectionInfo, footerSpacer, viewportInfo);

  container.append(toolbar, columnsPanel, scroller, footer);

  function getOrderedColumns(): GridColumn[] {
    return columns
      .filter(column => visibleColumns.has(column.key))
      .sort((left, right) => Number(pinnedColumns.has(right.key)) - Number(pinnedColumns.has(left.key)));
  }

  function computeActiveRows(): GridRow[] {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
    const filtered = rows.filter(row => {
      if (normalizedQuery && !columns.some(column => valueToText(row[column.key]).toLocaleLowerCase().includes(normalizedQuery))) {
        return false;
      }

      for (const [key, filter] of columnFilters) {
        const column = columns.find(item => item.key === key);
        if (column && isFilterActive(filter) && !matchesFilter(row[key], filter, column.type)) {
          return false;
        }
      }
      return true;
    });

    if (!sort) {
      return filtered;
    }

    const column = columns.find(item => item.key === sort?.key);
    if (!column) {
      return filtered;
    }

    return filtered
      .map((row, index) => ({row, index}))
      .sort((left, right) => {
        const result = compareValues(left.row[column.key], right.row[column.key], column.type);
        return result === 0
          ? left.index - right.index
          : result * (sort?.direction === 'ascending' ? 1 : -1);
      })
      .map(item => item.row);
  }

  function renderHeader() {
    closeMenus();
    head.replaceChildren();
    const headerRow = document.createElement('tr');
    const rowNumberHeader = document.createElement('th');
    rowNumberHeader.className = 'lake-grid__row-number lake-grid__row-number--header';
    rowNumberHeader.scope = 'col';
    rowNumberHeader.textContent = '#';
    headerRow.appendChild(rowNumberHeader);

    const orderedColumns = getOrderedColumns();
    let pinnedOffset = 42;
    orderedColumns.forEach((column, columnIndex) => {
      const header = document.createElement('th');
      header.scope = 'col';
      header.dataset.column = column.key;
      header.dataset.gridCell = 'true';
      header.dataset.rowIndex = '-1';
      header.dataset.columnIndex = String(columnIndex);
      header.tabIndex = -1;
      header.title = `Select ${column.label} header`;
      setColumnWidth(header, column.width);
      applyPinnedPosition(header, pinnedOffset, pinnedColumns.has(column.key));

      header.addEventListener('mousedown', event => {
        const target = event.target as HTMLElement;
        if (!target.closest('button, input, select, .lake-grid__resize-handle')) {
          startCellSelection(event, {row: -1, column: columnIndex});
        }
      });
      header.addEventListener('mouseenter', () => {
        if (pointerSelecting) {
          selectionFocus = {row: -1, column: columnIndex};
          updateSelectionDisplay();
        }
      });

      header.addEventListener('dragstart', event => {
        if ((event.target as HTMLElement).closest('.lake-grid__icon-button, input, select, .lake-grid__resize-handle')) {
          event.preventDefault();
          return;
        }
        draggedColumnKey = column.key;
        header.classList.add('lake-grid__dragging');
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', column.key);
        }
      });
      header.addEventListener('dragover', event => {
        if (draggedColumnKey && draggedColumnKey !== column.key) {
          event.preventDefault();
          header.classList.add('lake-grid__drag-target');
        }
      });
      header.addEventListener('dragleave', () => header.classList.remove('lake-grid__drag-target'));
      header.addEventListener('drop', event => {
        event.preventDefault();
        header.classList.remove('lake-grid__drag-target');
        if (draggedColumnKey && draggedColumnKey !== column.key) {
          reorderColumn(draggedColumnKey, column.key);
        }
      });
      header.addEventListener('dragend', () => {
        draggedColumnKey = undefined;
        container.querySelectorAll('.lake-grid__dragging, .lake-grid__drag-target')
          .forEach(item => item.classList.remove('lake-grid__dragging', 'lake-grid__drag-target'));
      });

      const headerContent = createElement('div', 'lake-grid__column-header');
      const typeBadge = createElement('span', `lake-grid__type lake-grid__type--${column.type}`, typeLabel(column.type));
      typeBadge.title = `${column.type} column`;
      const label = createElement('button', 'lake-grid__column-label', column.label);
      label.type = 'button';
      label.draggable = true;
      label.title = `Sort by ${column.label}; drag to reorder`;
      const toggleSort = () => {
        sort = sort?.key === column.key && sort.direction === 'ascending'
          ? {key: column.key, direction: 'descending'}
          : {key: column.key, direction: 'ascending'};
        refreshData(true, true);
      };
      label.addEventListener('click', toggleSort);

      const sortButton = iconButton('sort', `Sort ${column.label} ascending`);
      sortButton.classList.add('lake-grid__sort');
      if (sort?.key === column.key) {
        replaceButtonIcon(sortButton, sort.direction === 'ascending' ? 'sortAscending' : 'sortDescending');
        sortButton.title = `${column.label}: sorted ${sort.direction}`;
        sortButton.setAttribute('aria-label', sortButton.title);
        sortButton.setAttribute('aria-pressed', 'true');
        sortButton.classList.add('is-active');
      } else {
        sortButton.setAttribute('aria-pressed', 'false');
      }
      sortButton.addEventListener('click', toggleSort);

      const menuButton = iconButton('more', `${column.label} options`);
      menuButton.classList.add('lake-grid__column-menu-button');
      menuButton.classList.toggle('is-filtered', isFilterActive(columnFilters.get(column.key)));
      menuButton.setAttribute('aria-haspopup', 'menu');
      menuButton.setAttribute('aria-expanded', 'false');
      menuButton.addEventListener('click', event => {
        event.stopPropagation();
        toggleColumnMenu(header, column);
      });

      const resizeHandle = createElement('span', 'lake-grid__resize-handle');
      resizeHandle.title = `Resize ${column.label}`;
      resizeHandle.addEventListener('pointerdown', event => startColumnResize(event, column, columnIndex));
      resizeHandle.addEventListener('dblclick', event => {
        event.preventDefault();
        event.stopPropagation();
        column.width = inferWidth(column.label, rows.slice(0, 200).map(row => row[column.key]), column.type);
        renderHeader();
        renderViewport(true);
      });

      headerContent.append(typeBadge, label, menuButton, sortButton);
      header.append(headerContent, resizeHandle);
      headerRow.appendChild(header);
      if (pinnedColumns.has(column.key)) {
        pinnedOffset += column.width;
      }
    });
    head.appendChild(headerRow);

    if (filtersVisible) {
      const filterRow = document.createElement('tr');
      filterRow.className = 'lake-grid__filter-row';
      const blank = document.createElement('th');
      blank.className = 'lake-grid__row-number';
      filterRow.appendChild(blank);
      pinnedOffset = 42;

      orderedColumns.forEach((column, columnIndex) => {
        const cell = document.createElement('th');
        cell.dataset.columnIndex = String(columnIndex);
        setColumnWidth(cell, column.width);
        applyPinnedPosition(cell, pinnedOffset, pinnedColumns.has(column.key));
        const filter = columnFilters.get(column.key) ?? {operator: defaultOperator(column.type), value: ''};
        const filterEditor = createElement('div', 'lake-grid__filter-editor');
        const operatorSelect = document.createElement('select');
        operatorSelect.className = 'lake-grid__filter-operator';
        operatorSelect.title = `Filter operator for ${column.label}`;
        for (const option of getOperatorOptions(column.type)) {
          const element = document.createElement('option');
          element.value = option.value;
          element.textContent = option.label;
          element.selected = option.value === filter.operator;
          operatorSelect.appendChild(element);
        }
        operatorSelect.addEventListener('change', () => {
          const operator = operatorSelect.value as FilterOperator;
          updateColumnFilter(column, operator, filterNeedsValue(operator) ? filter.value : '', true);
        });
        filterEditor.appendChild(operatorSelect);

        if (filterNeedsValue(filter.operator)) {
          const valueEditor = createFilterValueEditor(column, filter.value, value => {
            updateColumnFilter(column, operatorSelect.value as FilterOperator, value, false);
          });
          valueEditor.dataset.filterColumn = column.key;
          filterEditor.appendChild(valueEditor);
        }
        cell.appendChild(filterEditor);
        filterRow.appendChild(cell);
        if (pinnedColumns.has(column.key)) {
          pinnedOffset += column.width;
        }
      });
      head.appendChild(filterRow);
    }
  }

  function renderViewport(force = false) {
    const orderedColumns = getOrderedColumns();
    const rowHeight = getRowHeight();
    const headerHeight = rowHeight * (filtersVisible ? 2 : 1);
    const dataScrollTop = Math.max(0, scroller.scrollTop - headerHeight);
    const viewportHeight = scroller.clientHeight || 430;
    const visibleCount = Math.ceil(viewportHeight / rowHeight);
    const visibleStart = Math.max(0, Math.floor(dataScrollTop / rowHeight));
    const visibleEnd = Math.min(activeRows.length, visibleStart + visibleCount);
    const start = Math.max(0, visibleStart - virtualOverscan);
    const end = Math.min(activeRows.length, visibleEnd + virtualOverscan);

    if (!force && start === renderedStart && end === renderedEnd) {
      return;
    }
    renderedStart = start;
    renderedEnd = end;
    body.replaceChildren();
    table.setAttribute('aria-rowcount', String(activeRows.length));
    table.setAttribute('aria-colcount', String(orderedColumns.length));

    if (activeRows.length === 0) {
      const emptyRow = document.createElement('tr');
      const emptyCell = document.createElement('td');
      emptyCell.className = 'lake-grid__empty';
      emptyCell.colSpan = orderedColumns.length + 1;
      emptyCell.textContent = rows.length === 0 ? 'No rows to display' : 'No rows match the current filters';
      emptyRow.appendChild(emptyCell);
      body.appendChild(emptyRow);
    } else {
      appendVirtualSpacer(start * rowHeight, orderedColumns.length + 1);
      for (let rowIndex = start; rowIndex < end; rowIndex++) {
        const row = activeRows[rowIndex];
        const tr = document.createElement('tr');
        tr.dataset.rowIndex = String(rowIndex);
        const numberCell = document.createElement('td');
        numberCell.className = 'lake-grid__row-number';
        numberCell.textContent = String(rowIndex + 1);
        tr.appendChild(numberCell);

        let pinnedOffset = 42;
        orderedColumns.forEach((column, columnIndex) => {
          const cell = document.createElement('td');
          cell.dataset.gridCell = 'true';
          cell.dataset.rowIndex = String(rowIndex);
          cell.dataset.columnIndex = String(columnIndex);
          cell.tabIndex = -1;
          setColumnWidth(cell, column.width);
          const value = row[column.key];
          cell.textContent = formatValue(value, column, columnFormats.get(column.key) ?? 'auto');
          cell.title = valueToText(value);
          cell.classList.add(`lake-grid__cell--${column.type}`);
          if (value === null || value === undefined) {
            cell.classList.add('lake-grid__null');
          }
          applyPinnedPosition(cell, pinnedOffset, pinnedColumns.has(column.key));
          cell.addEventListener('mousedown', event => startCellSelection(event, {row: rowIndex, column: columnIndex}));
          cell.addEventListener('mouseenter', () => {
            if (pointerSelecting) {
              selectionFocus = {row: rowIndex, column: columnIndex};
              updateSelectionDisplay();
            }
          });
          tr.appendChild(cell);
          if (pinnedColumns.has(column.key)) {
            pinnedOffset += column.width;
          }
        });
        body.appendChild(tr);
      }
      appendVirtualSpacer((activeRows.length - end) * rowHeight, orderedColumns.length + 1);
    }

    footerCount.textContent = `${activeRows.length.toLocaleString()} row${activeRows.length === 1 ? '' : 's'}`;
    viewportInfo.textContent = activeRows.length === 0
      ? '0–0'
      : `${visibleStart + 1}–${visibleEnd} of ${activeRows.length.toLocaleString()}`;
    updateSelectionDisplay();
  }

  function appendVirtualSpacer(height: number, columnCount: number) {
    if (height <= 0) {
      return;
    }
    const spacerRow = document.createElement('tr');
    spacerRow.className = 'lake-grid__virtual-spacer';
    const spacerCell = document.createElement('td');
    spacerCell.colSpan = columnCount;
    spacerCell.style.height = `${height}px`;
    spacerRow.appendChild(spacerCell);
    body.appendChild(spacerRow);
  }

  function refreshData(renderTableHeader: boolean, resetScroll: boolean) {
    activeRows = computeActiveRows();
    renderedStart = -1;
    renderedEnd = -1;
    selectionAnchor = undefined;
    selectionFocus = undefined;
    if (resetScroll) {
      scroller.scrollTop = 0;
    }
    if (renderTableHeader) {
      renderHeader();
    }
    renderViewport(true);
  }

  function renderColumnsPanel() {
    columnsPanel.replaceChildren();
    const title = createElement('div', 'lake-grid__panel-title', 'Visible columns');
    const actions = createElement('div', 'lake-grid__panel-actions');
    const showAll = createElement('button', 'lake-grid__text-button', 'Show all');
    showAll.type = 'button';
    showAll.addEventListener('click', () => {
      columns.forEach(column => visibleColumns.add(column.key));
      resetSelection();
      renderHeader();
      renderViewport(true);
      renderColumnsPanel();
    });
    actions.appendChild(showAll);
    columnsPanel.append(title, actions);

    for (const column of columns) {
      const label = createElement('label', 'lake-grid__column-choice');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = visibleColumns.has(column.key);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          visibleColumns.add(column.key);
        } else if (visibleColumns.size > 1) {
          visibleColumns.delete(column.key);
          pinnedColumns.delete(column.key);
        } else {
          checkbox.checked = true;
        }
        resetSelection();
        renderHeader();
        renderViewport(true);
      });
      label.append(checkbox, createElement('span', '', column.label));
      columnsPanel.appendChild(label);
    }
  }

  function toggleColumnMenu(header: HTMLTableCellElement, column: GridColumn) {
    const wasOpen = header.querySelector('.lake-grid__column-menu-button')?.getAttribute('aria-expanded') === 'true';
    closeMenus();
    if (wasOpen) {
      return;
    }

    const menu = createMenu(header);
    menu.append(
      menuItem('Copy column name', 'copy', async () => copyText(column.label)),
      menuItem('Filter…', 'filter', () => {
        filtersVisible = true;
        filterButton.classList.add('is-active');
        renderHeader();
        renderViewport(true);
        const input = Array.from(head.querySelectorAll<HTMLElement>('[data-filter-column]'))
          .find(editor => editor.dataset.filterColumn === column.key);
        input?.focus();
      }),
      menuItem('Format…', 'format', () => openFormatMenu(header, column)),
      menuItem(pinnedColumns.has(column.key) ? 'Unpin column' : 'Pin column', 'pin', () => {
        if (pinnedColumns.has(column.key)) {
          pinnedColumns.delete(column.key);
        } else {
          pinnedColumns.add(column.key);
        }
        resetSelection();
        renderHeader();
        renderViewport(true);
      }),
      createElement('div', 'lake-grid__menu-separator'),
      menuItem('Move column left', undefined, () => moveColumn(column.key, -1)),
      menuItem('Move column right', undefined, () => moveColumn(column.key, 1)),
      menuItem('Hide column', 'hide', () => {
        if (visibleColumns.size > 1) {
          visibleColumns.delete(column.key);
          pinnedColumns.delete(column.key);
          resetSelection();
          renderHeader();
          renderViewport(true);
          renderColumnsPanel();
        }
      })
    );
    showMenu(menu, header);
  }

  function createMenu(header: HTMLTableCellElement): HTMLDivElement {
    const menu = createElement('div', 'lake-grid__menu');
    menu.setAttribute('role', 'menu');
    return menu;
  }

  function showMenu(menu: HTMLDivElement, header: HTMLTableCellElement) {
    menu.classList.add('lake-grid__menu--portal');
    menu.style.visibility = 'hidden';
    document.body.appendChild(menu);
    activeMenu = menu;
    activeMenuHeader = header;
    header.classList.add('lake-grid__menu-open');
    header.querySelector('.lake-grid__column-menu-button')?.setAttribute('aria-expanded', 'true');

    menuCompletionHandlers.set(menu, () => {
      if (activeMenu === menu) {
        closeMenus();
      } else {
        menu.remove();
      }
    });

    activeMenuPointerDismiss = event => {
      const target = event.target as Node | null;
      if (target && !menu.contains(target) && !header.contains(target)) {
        closeMenus();
      }
    };
    activeMenuKeyDismiss = event => {
      if (event.key === 'Escape') {
        closeMenus();
        header.querySelector<HTMLButtonElement>('.lake-grid__column-menu-button')?.focus();
      }
    };
    document.addEventListener('pointerdown', activeMenuPointerDismiss, true);
    document.addEventListener('keydown', activeMenuKeyDismiss, true);

    window.requestAnimationFrame(() => {
      if (activeMenu !== menu || !header.isConnected) {
        closeMenus();
        return;
      }
      const headerRect = header.getBoundingClientRect();
      const menuWidth = menu.offsetWidth || 190;
      const menuHeight = menu.offsetHeight;
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const left = Math.max(4, Math.min(headerRect.left, viewportWidth - menuWidth - 4));
      const spaceBelow = viewportHeight - headerRect.bottom - 4;
      const spaceAbove = headerRect.top - 4;
      const openBelow = spaceBelow >= menuHeight || spaceBelow >= spaceAbove;
      const availableHeight = Math.max(40, openBelow ? spaceBelow : spaceAbove);
      menu.style.maxHeight = `${availableHeight}px`;
      const top = openBelow
        ? headerRect.bottom + 2
        : Math.max(4, headerRect.top - Math.min(menuHeight, availableHeight) - 2);
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
      menu.style.visibility = 'visible';
      menu.querySelector<HTMLButtonElement>('.lake-grid__menu-item')?.focus({preventScroll: true});
    });
  }

  function openFormatMenu(header: HTMLTableCellElement, column: GridColumn) {
    closeMenus();
    const menu = createMenu(header);
    menu.classList.add('lake-grid__format-menu');
    menu.appendChild(createElement('div', 'lake-grid__menu-title', `Format ${column.label}`));
    const selectedFormat = columnFormats.get(column.key) ?? 'auto';
    for (const option of getFormatOptions(column.type)) {
      const item = menuItem(`${option.value === selectedFormat ? '✓  ' : '    '}${option.label}`, undefined, () => {
        if (option.value === 'auto') {
          columnFormats.delete(column.key);
        } else {
          columnFormats.set(column.key, option.value);
        }
        renderViewport(true);
      });
      menu.appendChild(item);
    }
    showMenu(menu, header);
  }

  function closeMenus() {
    if (!activeMenu && !activeMenuHeader && !activeMenuPointerDismiss && !activeMenuKeyDismiss) {
      return;
    }
    if (activeMenuPointerDismiss) {
      document.removeEventListener('pointerdown', activeMenuPointerDismiss, true);
    }
    if (activeMenuKeyDismiss) {
      document.removeEventListener('keydown', activeMenuKeyDismiss, true);
    }
    if (activeMenu) {
      menuCompletionHandlers.delete(activeMenu);
      activeMenu.remove();
    }
    activeMenuHeader?.classList.remove('lake-grid__menu-open');
    activeMenuHeader?.querySelector('.lake-grid__column-menu-button')?.setAttribute('aria-expanded', 'false');
    activeMenu = undefined;
    activeMenuHeader = undefined;
    activeMenuPointerDismiss = undefined;
    activeMenuKeyDismiss = undefined;
  }

  function updateColumnFilter(column: GridColumn, operator: FilterOperator, value: string, renderTableHeader: boolean) {
    columnFilters.set(column.key, {operator, value});
    activeRows = computeActiveRows();
    resetSelection();
    scroller.scrollTop = 0;
    renderedStart = -1;
    renderedEnd = -1;
    if (renderTableHeader) {
      renderHeader();
    } else {
      const index = getOrderedColumns().findIndex(item => item.key === column.key);
      head.querySelector(`th[data-column-index="${index}"] .lake-grid__column-menu-button`)
        ?.classList.toggle('is-filtered', isFilterActive(columnFilters.get(column.key)));
    }
    renderViewport(true);
  }

  function createFilterValueEditor(column: GridColumn, value: string, onChange: (value: string) => void): HTMLInputElement | HTMLSelectElement {
    if (column.type === 'boolean') {
      const select = document.createElement('select');
      select.className = 'lake-grid__filter-value';
      for (const optionValue of ['', 'true', 'false']) {
        const option = document.createElement('option');
        option.value = optionValue;
        option.textContent = optionValue || 'value…';
        option.selected = optionValue === value;
        select.appendChild(option);
      }
      select.addEventListener('change', () => onChange(select.value));
      return select;
    }

    const input = document.createElement('input');
    input.className = 'lake-grid__filter-value';
    input.type = column.type === 'integer' || column.type === 'number'
      ? 'number'
      : column.type === 'date' ? 'date' : 'search';
    input.placeholder = 'value…';
    input.value = value;
    input.addEventListener('input', () => onChange(input.value));
    return input;
  }

  function startColumnResize(event: PointerEvent, column: GridColumn, columnIndex: number) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = column.width;
    container.classList.add('lake-grid--resizing');

    const move = (moveEvent: PointerEvent) => {
      column.width = Math.max(80, Math.min(600, startWidth + moveEvent.clientX - startX));
      container.querySelectorAll<HTMLElement>(`[data-column-index="${columnIndex}"]`)
        .forEach(element => setColumnWidth(element, column.width));
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      container.classList.remove('lake-grid--resizing');
      renderHeader();
      renderViewport(true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
  }

  function reorderColumn(sourceKey: string, targetKey: string) {
    const sourceIndex = columns.findIndex(column => column.key === sourceKey);
    const targetIndex = columns.findIndex(column => column.key === targetKey);
    if (sourceIndex < 0 || targetIndex < 0) {
      return;
    }
    const [column] = columns.splice(sourceIndex, 1);
    columns.splice(targetIndex, 0, column);
    draggedColumnKey = undefined;
    resetSelection();
    renderColumnsPanel();
    renderHeader();
    renderViewport(true);
  }

  function moveColumn(key: string, direction: -1 | 1) {
    const index = columns.findIndex(column => column.key === key);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= columns.length) {
      return;
    }
    [columns[index], columns[targetIndex]] = [columns[targetIndex], columns[index]];
    resetSelection();
    renderColumnsPanel();
    renderHeader();
    renderViewport(true);
  }

  function startCellSelection(event: MouseEvent, position: GridPosition) {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    scroller.focus({preventScroll: true});
    if (!event.shiftKey || !selectionAnchor) {
      selectionAnchor = position;
    }
    selectionFocus = position;
    pointerSelecting = true;
    updateSelectionDisplay();
    const finish = () => {
      pointerSelecting = false;
      window.removeEventListener('mouseup', finish);
    };
    window.addEventListener('mouseup', finish);
  }

  function updateSelectionDisplay() {
    const range = getSelectionRange();
    container.querySelectorAll<HTMLElement>('[data-grid-cell]').forEach(cell => {
      const row = Number(cell.dataset.rowIndex);
      const column = Number(cell.dataset.columnIndex);
      cell.classList.toggle('is-selected', Boolean(range &&
        row >= range.startRow && row <= range.endRow &&
        column >= range.startColumn && column <= range.endColumn));
      cell.classList.toggle('is-selection-focus', Boolean(selectionFocus &&
        row === selectionFocus.row && column === selectionFocus.column));
    });

    if (range) {
      const cellCount = (range.endRow - range.startRow + 1) * (range.endColumn - range.startColumn + 1);
      selectionInfo.textContent = `• ${cellCount.toLocaleString()} cell${cellCount === 1 ? '' : 's'} selected`;
      copyButton.disabled = false;
    } else {
      selectionInfo.textContent = '';
      copyButton.disabled = true;
    }
  }

  function getSelectionRange() {
    if (!selectionAnchor || !selectionFocus) {
      return undefined;
    }
    return {
      startRow: Math.min(selectionAnchor.row, selectionFocus.row),
      endRow: Math.max(selectionAnchor.row, selectionFocus.row),
      startColumn: Math.min(selectionAnchor.column, selectionFocus.column),
      endColumn: Math.max(selectionAnchor.column, selectionFocus.column)
    };
  }

  function resetSelection() {
    selectionAnchor = undefined;
    selectionFocus = undefined;
    updateSelectionDisplay();
  }

  async function copySelection() {
    const range = getSelectionRange();
    if (!range) {
      return;
    }
    const orderedColumns = getOrderedColumns();
    const selectedColumns = orderedColumns.slice(range.startColumn, range.endColumn + 1);
    const lines: string[] = [];
    if (range.startRow <= -1 && range.endRow >= -1) {
      lines.push(selectedColumns.map(column => column.label).join('\t'));
    }
    if (range.endRow >= 0) {
      lines.push(...activeRows
        .slice(Math.max(0, range.startRow), range.endRow + 1)
        .map(row => selectedColumns
        .map(column => formatValue(row[column.key], column, columnFormats.get(column.key) ?? 'auto'))
          .join('\t')));
    }
    const text = lines.join('\r\n');
    await copyText(text);
    copyButton.classList.add('is-success');
    window.setTimeout(() => copyButton.classList.remove('is-success'), 700);
  }

  function moveSelection(rowDelta: number, columnDelta: number, extend: boolean) {
    const orderedColumns = getOrderedColumns();
    if (orderedColumns.length === 0) {
      return;
    }
    const current = selectionFocus ?? {row: 0, column: 0};
    const next = {
      row: Math.max(-1, Math.min(Math.max(-1, activeRows.length - 1), current.row + rowDelta)),
      column: Math.max(0, Math.min(orderedColumns.length - 1, current.column + columnDelta))
    };
    if (!extend || !selectionAnchor) {
      selectionAnchor = next;
    }
    selectionFocus = next;
    ensurePositionVisible(next);
    renderViewport(true);
    const selectedCell = table.querySelector<HTMLElement>(
      `[data-grid-cell][data-row-index="${next.row}"][data-column-index="${next.column}"]`
    );
    selectedCell?.scrollIntoView({block: 'nearest', inline: 'nearest'});
    scroller.focus({preventScroll: true});
  }

  function ensurePositionVisible(position: GridPosition) {
    if (position.row === -1) {
      scroller.scrollTop = 0;
      return;
    }
    const rowHeight = getRowHeight();
    const headerHeight = rowHeight * (filtersVisible ? 2 : 1);
    const rowTop = headerHeight + position.row * rowHeight;
    const rowBottom = rowTop + rowHeight;
    if (rowTop < scroller.scrollTop + headerHeight) {
      scroller.scrollTop = Math.max(0, rowTop - headerHeight);
    } else if (rowBottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = rowBottom - scroller.clientHeight;
    }
  }

  function getRowHeight() {
    return container.classList.contains('lake-grid--comfortable') ? comfortableRowHeight : compactRowHeight;
  }

  searchButton.addEventListener('click', () => {
    searchVisible = !searchVisible;
    searchBox.hidden = !searchVisible;
    searchButton.classList.toggle('is-active', searchVisible);
    if (searchVisible) {
      searchInput.focus();
    } else {
      searchInput.value = '';
      searchQuery = '';
      refreshData(false, true);
    }
  });
  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value;
    refreshData(false, true);
  });
  filterButton.addEventListener('click', () => {
    filtersVisible = !filtersVisible;
    filterButton.classList.toggle('is-active', filtersVisible);
    if (!filtersVisible) {
      columnFilters.clear();
    }
    refreshData(true, true);
  });
  columnsButton.addEventListener('click', event => {
    event.stopPropagation();
    columnsPanel.hidden = !columnsPanel.hidden;
    columnsButton.classList.toggle('is-active', !columnsPanel.hidden);
  });
  densityButton.addEventListener('click', () => {
    container.classList.toggle('lake-grid--comfortable');
    densityButton.classList.toggle('is-active');
    renderedStart = -1;
    renderedEnd = -1;
    renderHeader();
    renderViewport(true);
  });
  copyButton.addEventListener('click', () => void copySelection());
  downloadButton.addEventListener('click', () => downloadCsv(activeRows, getOrderedColumns()));
  scroller.addEventListener('scroll', () => {
    closeMenus();
    if (scrollFrame) {
      return;
    }
    scrollFrame = window.requestAnimationFrame(() => {
      scrollFrame = 0;
      renderViewport();
    });
  });
  container.addEventListener('click', event => {
    const target = event.target as HTMLElement;
    if (!target.closest('.lake-grid__menu') && !target.closest('.lake-grid__column-menu-button')) {
      closeMenus();
    }
    if (!target.closest('.lake-grid__columns-panel') && !target.closest('[title="Choose columns"]')) {
      columnsPanel.hidden = true;
      columnsButton.classList.remove('is-active');
    }
  });
  container.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      closeMenus();
      columnsPanel.hidden = true;
      columnsButton.classList.remove('is-active');
      resetSelection();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'c' && selectionAnchor) {
      event.preventDefault();
      void copySelection();
      return;
    }
    if ((event.target as HTMLElement).matches('input, select, button')) {
      return;
    }
    const movements: Record<string, [number, number]> = {
      ArrowDown: [1, 0],
      ArrowUp: [-1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1]
    };
    const movement = movements[event.key];
    if (movement) {
      event.preventDefault();
      moveSelection(movement[0], movement[1], event.shiftKey);
    }
  });

  renderColumnsPanel();
  activeRows = computeActiveRows();
  renderHeader();
  renderViewport(true);
}

function normalizeRows(data: unknown[]): GridRow[] {
  return data.map(value => {
    if (Array.isArray(value)) {
      return Object.fromEntries(value.map((cell, index) => [`Column ${index + 1}`, cell]));
    }
    if (value !== null && typeof value === 'object') {
      return value as GridRow;
    }
    return {Value: value};
  });
}

function createColumns(rows: GridRow[]): GridColumn[] {
  const keys = new Set<string>();
  for (const row of rows) {
    Object.keys(row).forEach(key => keys.add(key));
  }

  return Array.from(keys).map(key => {
    const values = rows.slice(0, 200).map(row => row[key]);
    const type = inferType(values);
    return {key, label: key, type, width: inferWidth(key, values, type)};
  });
}

function inferType(values: unknown[]): ColumnType {
  const value = values.find(item => item !== null && item !== undefined);
  if (value instanceof Date) {
    return 'date';
  }
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  if (typeof value === 'object') {
    return 'object';
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.+-]+Z?)?$/.test(value)) {
    return 'date';
  }
  return 'string';
}

function inferWidth(key: string, values: unknown[], type: ColumnType): number {
  const sampleLength = values.reduce<number>((maximum, value) => Math.max(maximum, valueToText(value).length), key.length);
  const controlPadding = type === 'string' ? 98 : 92;
  return Math.max(190, Math.min(360, sampleLength * 7.2 + controlPadding));
}

function typeLabel(type: ColumnType): string {
  switch (type) {
    case 'boolean': return '01';
    case 'date': return '▦';
    case 'integer': return '123';
    case 'number': return '1.2';
    case 'object': return '{}';
    default: return 'ABC';
  }
}

function defaultOperator(type: ColumnType): FilterOperator {
  return type === 'string' || type === 'object' ? 'contains' : 'equals';
}

function getOperatorOptions(type: ColumnType): OperatorOption[] {
  const emptiness: OperatorOption[] = [
    {value: 'empty', label: 'Empty'},
    {value: 'notEmpty', label: 'Not empty'}
  ];
  if (type === 'integer' || type === 'number') {
    return [
      {value: 'equals', label: '='},
      {value: 'notEquals', label: '≠'},
      {value: 'greater', label: '>'},
      {value: 'greaterOrEqual', label: '≥'},
      {value: 'less', label: '<'},
      {value: 'lessOrEqual', label: '≤'},
      ...emptiness
    ];
  }
  if (type === 'date') {
    return [
      {value: 'on', label: 'On'},
      {value: 'before', label: 'Before'},
      {value: 'after', label: 'After'},
      ...emptiness
    ];
  }
  if (type === 'boolean') {
    return [{value: 'equals', label: '='}, {value: 'notEquals', label: '≠'}, ...emptiness];
  }
  return [
    {value: 'contains', label: 'Contains'},
    {value: 'notContains', label: 'Not contains'},
    {value: 'equals', label: 'Equals'},
    {value: 'notEquals', label: 'Not equal'},
    {value: 'startsWith', label: 'Starts with'},
    ...emptiness
  ];
}

function filterNeedsValue(operator: FilterOperator): boolean {
  return operator !== 'empty' && operator !== 'notEmpty';
}

function isFilterActive(filter: ColumnFilter | undefined): boolean {
  return Boolean(filter && (!filterNeedsValue(filter.operator) || filter.value.trim().length > 0));
}

function matchesFilter(value: unknown, filter: ColumnFilter, type: ColumnType): boolean {
  const empty = value === null || value === undefined || valueToText(value).length === 0;
  if (filter.operator === 'empty') {
    return empty;
  }
  if (filter.operator === 'notEmpty') {
    return !empty;
  }
  if (empty) {
    return false;
  }

  if (type === 'integer' || type === 'number') {
    const left = Number(value);
    const right = Number(filter.value);
    switch (filter.operator) {
      case 'equals': return left === right;
      case 'notEquals': return left !== right;
      case 'greater': return left > right;
      case 'greaterOrEqual': return left >= right;
      case 'less': return left < right;
      case 'lessOrEqual': return left <= right;
    }
  }

  if (type === 'date') {
    const left = new Date(String(value)).getTime();
    const right = new Date(filter.value).getTime();
    if (Number.isNaN(left) || Number.isNaN(right)) {
      return false;
    }
    switch (filter.operator) {
      case 'on': return new Date(left).toDateString() === new Date(right).toDateString();
      case 'before': return left < right;
      case 'after': return left > right;
    }
  }

  const left = valueToText(value).toLocaleLowerCase();
  const right = filter.value.toLocaleLowerCase();
  switch (filter.operator) {
    case 'contains': return left.includes(right);
    case 'notContains': return !left.includes(right);
    case 'equals': return left === right;
    case 'notEquals': return left !== right;
    case 'startsWith': return left.startsWith(right);
    default: return true;
  }
}

function getFormatOptions(type: ColumnType): FormatOption[] {
  if (type === 'integer' || type === 'number') {
    return [
      {value: 'auto', label: 'Automatic'},
      {value: 'raw', label: 'Raw number'},
      {value: 'locale', label: 'Locale separators'},
      {value: 'fixed2', label: 'Two decimals'},
      {value: 'percent', label: 'Percentage'}
    ];
  }
  if (type === 'date') {
    return [
      {value: 'auto', label: 'Original value'},
      {value: 'date', label: 'Local date'},
      {value: 'datetime', label: 'Local date and time'}
    ];
  }
  if (type === 'boolean') {
    return [{value: 'auto', label: 'true / false'}, {value: 'yesNo', label: 'Yes / No'}];
  }
  if (type === 'object') {
    return [{value: 'auto', label: 'Compact JSON'}, {value: 'json', label: 'JSON'}];
  }
  return [
    {value: 'auto', label: 'Original value'},
    {value: 'uppercase', label: 'UPPERCASE'},
    {value: 'lowercase', label: 'lowercase'}
  ];
}

function valueToText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function formatValue(value: unknown, column: GridColumn, format: ColumnFormat): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if ((column.type === 'integer' || column.type === 'number') && format !== 'auto') {
    const number = Number(value);
    if (format === 'locale') {
      return new Intl.NumberFormat().format(number);
    }
    if (format === 'fixed2') {
      return number.toFixed(2);
    }
    if (format === 'percent') {
      return new Intl.NumberFormat(undefined, {style: 'percent', maximumFractionDigits: 2}).format(number);
    }
    return String(number);
  }
  if (column.type === 'date' && (format === 'date' || format === 'datetime')) {
    const date = value instanceof Date ? value : new Date(String(value));
    if (!Number.isNaN(date.getTime())) {
      return format === 'date'
        ? new Intl.DateTimeFormat().format(date)
        : new Intl.DateTimeFormat(undefined, {dateStyle: 'short', timeStyle: 'medium'}).format(date);
    }
  }
  if (column.type === 'boolean' && format === 'yesNo') {
    return Boolean(value) ? 'Yes' : 'No';
  }
  if (column.type === 'string' && format === 'uppercase') {
    return String(value).toLocaleUpperCase();
  }
  if (column.type === 'string' && format === 'lowercase') {
    return String(value).toLocaleLowerCase();
  }
  return valueToText(value);
}

function compareValues(left: unknown, right: unknown, type: ColumnType): number {
  if (left === null || left === undefined) {
    return right === null || right === undefined ? 0 : 1;
  }
  if (right === null || right === undefined) {
    return -1;
  }
  if (type === 'integer' || type === 'number') {
    return Number(left) - Number(right);
  }
  if (type === 'boolean') {
    return Number(left) - Number(right);
  }
  if (type === 'date') {
    return new Date(String(left)).getTime() - new Date(String(right)).getTime();
  }
  return valueToText(left).localeCompare(valueToText(right), undefined, {numeric: true, sensitivity: 'base'});
}

function applyPinnedPosition(element: HTMLElement, offset: number, pinned: boolean) {
  if (pinned) {
    element.classList.add('lake-grid__pinned');
    element.style.left = `${offset}px`;
  }
}

function setColumnWidth(element: HTMLElement, width: number) {
  const value = `${Math.round(width)}px`;
  element.style.width = value;
  element.style.minWidth = value;
  element.style.maxWidth = value;
}

function createElement<K extends keyof HTMLElementTagNameMap>(tagName: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

function createSvgIcon(name: IconName): SVGSVGElement {
  const paths: Record<IconName, string> = {
    chevronDown: 'M4 6l4 4 4-4',
    columns: 'M2.5 3h11v10h-11zM6.2 3v10M9.8 3v10',
    copy: 'M5 5h8v8H5zM3 11H2.5V2.5H11V3',
    density: 'M3 4h10M3 8h10M3 12h10',
    download: 'M8 2v8M5 7l3 3 3-3M3 13h10',
    filter: 'M2.5 3h11L9.5 7.7V12l-3 1V7.7z',
    format: 'M3 12l3.5-9h2L12 12M4.3 9h6.4',
    hide: 'M2 3l12 10M6.2 6.3A2.5 2.5 0 0010 9.5M3.2 5.5C2.4 6.2 1.8 7 1.5 8c1.1 3 3.2 4.5 6.5 4.5 1.1 0 2.1-.2 2.9-.6M6.7 3.6c.4-.1.8-.1 1.3-.1 3.3 0 5.4 1.5 6.5 4.5-.3.7-.7 1.4-1.2 1.9',
    more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
    pin: 'M5 2.5h6M6 2.5l.5 4-2 2h7l-2-2 .5-4M8 8.5v5',
    search: 'M7 2.5a4.5 4.5 0 110 9 4.5 4.5 0 010-9zM10.4 10.4L14 14',
    sort: 'M5 3v10M3 5l2-2 2 2M11 13V3M9 11l2 2 2-2',
    sortAscending: 'M5 13V3M3 5l2-2 2 2M9 6h4M9 9h3M9 12h2',
    sortDescending: 'M5 3v10M3 11l2 2 2-2M9 4h2M9 7h3M9 10h4'
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('lake-grid__svg-icon');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', name === 'more' ? '2.6' : '1.35');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', paths[name]);
  svg.appendChild(path);
  return svg;
}

function iconButton(icon: IconName, title: string): HTMLButtonElement {
  const button = createElement('button', 'lake-grid__icon-button');
  button.type = 'button';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.appendChild(createSvgIcon(icon));
  return button;
}

function replaceButtonIcon(button: HTMLButtonElement, icon: IconName) {
  button.querySelector('.lake-grid__svg-icon')?.replaceWith(createSvgIcon(icon));
}

function menuItem(label: string, icon: IconName | undefined, action: () => void | Promise<void>): HTMLButtonElement {
  const button = createElement('button', 'lake-grid__menu-item');
  button.type = 'button';
  button.setAttribute('role', 'menuitem');
  if (icon) {
    button.appendChild(createSvgIcon(icon));
  } else {
    button.appendChild(createElement('span', 'lake-grid__menu-icon-placeholder'));
  }
  button.appendChild(createElement('span', '', label));
  button.addEventListener('click', event => {
    event.stopPropagation();
    const parentMenu = button.closest<HTMLElement>('.lake-grid__menu');
    const complete = parentMenu ? menuCompletionHandlers.get(parentMenu) : undefined;
    void Promise.resolve(action()).finally(() => {
      if (complete) {
        complete();
      } else {
        parentMenu?.remove();
      }
    });
  });
  return button;
}

async function copyText(text: string) {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // The notebook webview can deny clipboard permission; use the DOM fallback.
    }
  }
  const input = document.createElement('textarea');
  input.value = text;
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  document.execCommand('copy');
  input.remove();
}

function downloadCsv(rows: GridRow[], columns: GridColumn[]) {
  const escapeCell = (value: unknown) => `"${valueToText(value).replace(/"/g, '""')}"`;
  const csv = [
    columns.map(column => escapeCell(column.label)).join(','),
    ...rows.map(row => columns.map(column => escapeCell(row[column.key])).join(','))
  ].join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], {type: 'text/csv;charset=utf-8'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'notebook-table.csv';
  link.click();
  URL.revokeObjectURL(url);
}
