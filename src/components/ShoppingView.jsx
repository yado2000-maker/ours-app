import CheckSVG from "./CheckSVG.jsx";
import { EmptyShoppingIcon, DeleteIcon } from "./Icons.jsx";

export default function ShoppingView({ shopping, onToggle, onDelete, onClearGot, t }) {
  const need = shopping.filter(s => !s.got);
  const got  = shopping.filter(s => s.got);
  const grouped = {};
  need.forEach(s => { const c = s.category || t.cats[8]; if (!grouped[c]) grouped[c] = []; grouped[c].push(s); });
  const usedCats = t.cats.filter(c => grouped[c]?.length > 0);

  return (
    <div className="list-view">
      <div className="list-header">
        <div className="list-title">{t.shopTitle}</div>
        {got.length > 0 && <button className="clear-btn" onClick={onClearGot}>{t.clearCart}</button>}
      </div>
      {shopping.length === 0 ? (
        <div className="list-empty">
          <div className="list-empty-icon"><EmptyShoppingIcon size={44} /></div>
          <p className="list-empty-text">{t.shopEmpty}</p>
        </div>
      ) : (
        <>
          {need.length === 0 && (
            <div className="all-done-msg">{t.allInCart}</div>
          )}
          {usedCats.map(cat => (
            <div key={cat}>
              <div className="section-head">{cat}</div>
              {grouped[cat].map(s => (
                <div key={s.id} className="shop-row">
                  <div className={`shop-check ${s.got?"on":""}`} onClick={() => onToggle(s.id)}>
                    <CheckSVG />
                  </div>
                  <div className="shop-text">
                    <div className="shop-name">{s.name}</div>
                    {s.qty && <div className="shop-qty">{t.qtyLabel(s.qty)}</div>}
                  </div>
                  <button className="del-btn" onClick={() => onDelete("shop", s.id)}><DeleteIcon size={14} /></button>
                </div>
              ))}
            </div>
          ))}
          {got.length > 0 && (
            <>
              <div className="section-head">{t.inCart(got.length)}</div>
              {got.map(s => (
                <div key={s.id} className="shop-row got">
                  <div className="shop-check on" onClick={() => onToggle(s.id)}>
                    <CheckSVG />
                  </div>
                  <div className="shop-text"><div className="shop-name">{s.name}</div></div>
                  <div className="cat-badge">{s.category}</div>
                  <button className="del-btn" onClick={() => onDelete("shop", s.id)}><DeleteIcon size={14} /></button>
                </div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}
