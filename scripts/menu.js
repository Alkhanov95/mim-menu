const search = document.querySelector('#menu-search');
const links = [...document.querySelectorAll('[data-category]')];
const sections = [...document.querySelectorAll('.menu-section')];
const status = document.querySelector('#search-status');
const empty = document.querySelector('.empty-state');
const normalize = value => value.toLocaleLowerCase('ru-RU').replaceAll('ё', 'е').trim();
let selected = 'all';

function updateMenu() {
  const query = normalize(search.value);
  let count = 0;
  for (const section of sections) {
    const inCategory = selected === 'all' || section.id === selected || (selected === 'frozen' && section.dataset.frozen === 'true');
    let visible = 0;
    for (const dish of section.querySelectorAll('.dish')) {
      const match = inCategory && normalize(dish.dataset.name).includes(query);
      dish.hidden = !match;
      if (match) visible++;
    }
    for (const list of section.querySelectorAll('.dish-grid, .dish-list')) {
      list.hidden = ![...list.children].some(dish => !dish.hidden);
    }
    section.hidden = visible === 0;
    section.querySelector('.section-count').textContent = `${visible} поз.`;
    count += visible;
  }
  for (const link of links) {
    if (link.dataset.category === selected || (selected === 'frozen' && sections.some(section => section.id === link.dataset.category && section.dataset.frozen === 'true'))) link.setAttribute('aria-current', 'true');
    else link.removeAttribute('aria-current');
  }
  empty.hidden = count !== 0;
  status.hidden = !query;
  status.textContent = query ? `Найдено блюд: ${count}` : '';
}

function chooseCategory(category) {
  selected = category === 'frozen' || links.some(link => link.dataset.category === category) ? category : 'all';
  updateMenu();
}

for (const link of links) {
  link.addEventListener('click', event => {
    event.preventDefault();
    chooseCategory(link.dataset.category);
    history.replaceState(null, '', link.getAttribute('href'));
    link.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const menu = document.querySelector('#menu');
    if (menu.getBoundingClientRect().top < 0) menu.scrollIntoView({block: 'start'});
  });
}
search.addEventListener('input', updateMenu);
for (const link of document.querySelectorAll('[data-menu-view]')) {
  link.addEventListener('click', event => {
    event.preventDefault();
    search.value = '';
    chooseCategory(link.dataset.menuView);
    history.replaceState(null, '', selected === 'frozen' ? '#frozen' : '#menu');
    document.querySelector('#menu').scrollIntoView({ block: 'start' });
  });
}
document.querySelector('#reset-search').addEventListener('click', () => {
  search.value = '';
  chooseCategory('all');
  history.replaceState(null, '', '#menu');
  search.focus();
});
window.addEventListener('hashchange', () => {
  const category = location.hash.slice(1);
  if (category === 'menu' || category === 'frozen' || links.some(link => link.dataset.category === category)) {
    chooseCategory(category);
  }
});
document.querySelector('.search').hidden = false;
chooseCategory(location.hash.slice(1));
